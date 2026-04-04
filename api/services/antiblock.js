// ─────────────────────────────────────────────────────────────
// Anti-Blocking — 4 Layers Only:
//   1. Base delay (adaptive ตาม error rate)
//   2. Error backoff (pause เมื่อ error spike)
//   3. Work/rest cycle (ทำ-พัก เป็นรอบ)
//   4. All-down backoff (อยู่ใน search.js)
// ─────────────────────────────────────────────────────────────

const { log, todayStr, randomBetween, db } = require('../config/database');
const { ERROR_BUFFER_SIZE } = require('../config/constants');
const { notifyLark } = require('./notification');

const USING_PROXY = process.env.USE_PROXY === 'true';

// ─── Shared State ────────────────────────────────────────────
const abState = {
  errorBuffer: [],
  adaptiveDelayMean: 12,
  // Daily limit
  DAILY_LIMIT: randomBetween(2000, 3000),
  dailyLimitDate: todayStr(),
  dailyLimitTier: 'normal',
  // Hourly tracking
  hourlyResults: [],
  lowSuccessAlertSentAt: 0,
  rejectionSpikeAlerts: {},
};

// ─── Work Cycle System (Layer 3) ─────────────────────────────
const workCycle = {
  phase: 'idle', cycleCount: 0, phaseStart: null,
  workDuration: 0, restDuration: 0,
  queriesThisPhase: 0, totalQueriesToday: 0,
  todayDate: todayStr(),
};

function resetWorkCycleDaily() {
  const today = todayStr();
  if (today !== workCycle.todayDate) {
    workCycle.totalQueriesToday = 0;
    workCycle.cycleCount = 0;
    workCycle.todayDate = today;
  }
}

function startWorkPhase() {
  resetWorkCycleDaily();
  workCycle.phase = 'working';
  workCycle.cycleCount++;
  workCycle.phaseStart = Date.now();
  const errRate = getErrorRate();
  if (errRate < 0.1) workCycle.workDuration = randomBetween(60, 90) * 60 * 1000;
  else if (errRate < 0.3) workCycle.workDuration = randomBetween(45, 65) * 60 * 1000;
  else workCycle.workDuration = randomBetween(30, 45) * 60 * 1000;
  workCycle.queriesThisPhase = 0;
  log(`Work Phase ${workCycle.cycleCount} started — ${Math.round(workCycle.workDuration / 60000)} min`);
}

function startRestPhase() {
  workCycle.phase = 'resting';
  workCycle.phaseStart = Date.now();
  try {
    const stats = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(todayStr());
    const successRate = stats && stats.processed > 0 ? stats.found / stats.processed : 0;
    if (USING_PROXY) workCycle.restDuration = randomBetween(3, 8) * 60 * 1000;
    else if (successRate > 0.5) workCycle.restDuration = randomBetween(8, 15) * 60 * 1000;
    else if (successRate >= 0.2) workCycle.restDuration = randomBetween(15, 25) * 60 * 1000;
    else workCycle.restDuration = randomBetween(25, 40) * 60 * 1000;
  } catch { workCycle.restDuration = randomBetween(15, 30) * 60 * 1000; }
  log(`Rest Phase — ${Math.round(workCycle.restDuration / 60000)} min`);
}

function startLongRest() {
  workCycle.phase = 'long_rest';
  workCycle.phaseStart = Date.now();
  workCycle.restDuration = randomBetween(120, 240) * 60 * 1000;
  log(`Long Rest — ${Math.round(workCycle.restDuration / 60000)} min`);
}

function getRestRemaining() {
  if (workCycle.phase !== 'resting' && workCycle.phase !== 'long_rest') return 0;
  return Math.max(0, workCycle.restDuration - (Date.now() - workCycle.phaseStart));
}

function isWorkPhaseExpired() {
  if (workCycle.phase !== 'working') return false;
  return (Date.now() - workCycle.phaseStart) >= workCycle.workDuration;
}

// ─── Error Rate Helper ───────────────────────────────────────
function getErrorRate() {
  return abState.errorBuffer.length >= 5
    ? abState.errorBuffer.filter(Boolean).length / abState.errorBuffer.length
    : 0;
}

// ─── Layer 1: Base Delay (Adaptive) ─────────────────────────
// ครอบคลุม: slow start (queries แรกๆ delay สูงกว่า) + error-based scaling
// ไม่มี coffee break / ramp-up แยกอีกต่อไป
function getAdaptiveDelay(queriesThisPhase) {
  const errRate = getErrorRate();

  // Phase warm-up: 5 queries แรกของรอบ delay x1.3 (รวม slow start เข้ามา)
  const warmupMultiplier = queriesThisPhase < 5 ? 1.3 : 1.0;

  // Tor proxy = IP เดียว → ต้อง delay สูงกว่าเพื่อไม่ให้ถูก block
  if (USING_PROXY) {
    abState.adaptiveDelayMean = errRate > 0.5 ? 40 : errRate > 0.3 ? 25 : errRate > 0.15 ? 18 : 12;
    return gaussianDelay(abState.adaptiveDelayMean, 4, 8, 50) * warmupMultiplier;
  }
  abState.adaptiveDelayMean = errRate > 0.5 ? 50 : errRate > 0.3 ? 35 : errRate > 0.15 ? 22 : 15;
  return gaussianDelay(abState.adaptiveDelayMean, 5, 10, 60) * warmupMultiplier;
}

function gaussianDelay(mean, stddev, min, max) {
  let u1; do { u1 = Math.random(); } while (u1 === 0);
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * Math.random());
  return Math.round(Math.min(max, Math.max(min, mean + z * stddev)) * 10) / 10;
}

// ─── Layer 2: Error Backoff ──────────────────────────────────
// เมื่อ error rate สูง → pause นาน (รวม coffee break + error spike เดิม)
function trackResult(isError) {
  abState.errorBuffer.push(isError);
  if (abState.errorBuffer.length > ERROR_BUFFER_SIZE) abState.errorBuffer.shift();
}

function checkErrorBackoff() {
  const errRate = getErrorRate();
  if (abState.errorBuffer.length < 5) return { shouldPause: false, pauseDuration: 0 };

  // Critical: >50% errors → long pause
  if (errRate > 0.5) {
    abState.errorBuffer.length = 0;
    const pause = randomBetween(300, 600);
    log(`CRITICAL: Error rate ${(errRate * 100).toFixed(0)}% — pausing ${pause}s`);
    return { shouldPause: true, pauseDuration: pause };
  }
  // Warning: >30% errors → short pause
  if (errRate > 0.3) {
    abState.errorBuffer.length = 0;
    const pause = randomBetween(120, 300);
    log(`WARNING: Error rate ${(errRate * 100).toFixed(0)}% — pausing ${pause}s`);
    return { shouldPause: true, pauseDuration: pause };
  }
  return { shouldPause: false, pauseDuration: 0 };
}

// ─── Daily Limit ─────────────────────────────────────────────
function getDailyLimit() {
  const today = todayStr();
  if (today !== abState.dailyLimitDate) {
    abState.DAILY_LIMIT = randomBetween(2000, 3000);
    abState.dailyLimitDate = today;
    abState.dailyLimitTier = 'normal';
  }
  try {
    const stats = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(today);
    if (stats && stats.processed >= 50) {
      const foundRate = stats.found / stats.processed;
      if (foundRate > 0.50) { abState.DAILY_LIMIT = Math.max(abState.DAILY_LIMIT, randomBetween(3000, 4000)); abState.dailyLimitTier = 'high'; }
      else if (foundRate < 0.10) { abState.DAILY_LIMIT = Math.min(abState.DAILY_LIMIT, randomBetween(1800, 2200)); abState.dailyLimitTier = 'low'; }
      // found rate 10-50% = ปกติ ไม่ปรับ (เดิมลดที่ <20% ทำให้ limit ต่ำเกินไป)
      else abState.dailyLimitTier = 'normal';
    }
  } catch { /* ignore */ }
  return abState.DAILY_LIMIT;
}

// ─── Hourly Monitors ─────────────────────────────────────────
function checkHourlySuccessRate() {
  const oneHourAgo = Date.now() - 3600000;
  while (abState.hourlyResults.length > 0 && abState.hourlyResults[0].ts < oneHourAgo) abState.hourlyResults.shift();
  if (abState.hourlyResults.length < 20) return;
  const foundCount = abState.hourlyResults.filter(r => r.found).length;
  const rate = foundCount / abState.hourlyResults.length;
  if (rate < 0.15 && Date.now() - abState.lowSuccessAlertSentAt > 3600000) {
    abState.lowSuccessAlertSentAt = Date.now();
    notifyLark('Low Success Rate', `**${(rate * 100).toFixed(1)}%** ใน 1 ชม. (${foundCount}/${abState.hourlyResults.length})`, 'red');
  }
}

function checkRejectionSpike() {
  try {
    const recentReasons = db.prepare(`
      SELECT rejection_reason, COUNT(*) as cnt FROM companies
      WHERE rejection_reason IS NOT NULL AND processed_date >= datetime('now', '-1 hour', 'localtime')
      GROUP BY rejection_reason ORDER BY cnt DESC
    `).all();
    const total = recentReasons.reduce((s, r) => s + r.cnt, 0);
    if (total < 20) return;
    for (const r of recentReasons) {
      if (r.cnt / total > 0.5 && Date.now() - (abState.rejectionSpikeAlerts[r.rejection_reason] || 0) > 3600000) {
        abState.rejectionSpikeAlerts[r.rejection_reason] = Date.now();
        notifyLark('Rejection Spike', `**${r.rejection_reason}** ${Math.round(r.cnt / total * 100)}% (${r.cnt}/${total})`, 'yellow');
      }
    }
  } catch { /* ignore */ }
}

function resetAbState() {
  abState.errorBuffer.length = 0;
}

module.exports = {
  abState, workCycle,
  startWorkPhase, startRestPhase, startLongRest,
  getRestRemaining, isWorkPhaseExpired,
  getAdaptiveDelay, getErrorRate, trackResult,
  checkErrorBackoff,
  getDailyLimit, resetAbState,
  checkHourlySuccessRate, checkRejectionSpike,
};
