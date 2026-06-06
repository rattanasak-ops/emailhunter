// ─────────────────────────────────────────────────────────────
// Worker Service — Processing loop + State management
// ─────────────────────────────────────────────────────────────

const { db, log, todayStr, nowTimeStr, nowISOStr, ensureDailyStats, getDailyStats, getProcessedToday, formatNumber, randomBetween } = require('../config/database');
const { REJECTION_REASONS } = require('../config/constants');
const { notifyLark } = require('./notification');
const search = require('./search');
const { extractEmailCandidates, crawlForEmails, guessEmailByMX } = require('./crawler');
const { filterValidEmails } = require('./scorer');
const ab = require('./antiblock');

// ─── Session State ───────────────────────────────────────────
const session = {
  workerRunning: false,
  workerTimer: null,
  manualMode: null,
  manualModeSetAt: null,
  startTime: null,
  processed: 0,
  found: 0,
  blocksDetected: 0,
  recentSpeeds: [],
  lastActivityAt: null,
  lastError: null,
  idleSince: Date.now(),
  currentCompany: null,
};

const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const OFFICIAL_RECOVERY_SEARCHES = Math.max(0, Math.min(3, parseInt(process.env.OFFICIAL_RECOVERY_SEARCHES || '1', 10)));

function pickSearchEmails(results, companyName) {
  const candidates = extractEmailCandidates(results || [], companyName);
  if (candidates.length === 0) return { emails: [], sourceUrl: null, source: 'search' };

  const clean = candidates.filter(c => !['news', 'job', 'noise'].includes(c.sourceType));
  const fallback = clean.length > 0 ? clean : candidates;
  const emails = fallback.map(c => c.email);
  const first = fallback[0];
  const source = first && ['news', 'job', 'directory', 'social', 'noise'].includes(first.sourceType)
    ? 'search-noise'
    : 'search';

  return {
    emails,
    sourceUrl: first?.sourceUrl || null,
    source,
  };
}

function logSession() {
  if (session.startTime && session.processed > 0) {
    db.prepare(`INSERT INTO session_log (start_time, end_time, processed, found, not_found, errors, blocks_detected) VALUES (?,?,?,?,?,?,?)`)
      .run(session.startTime, nowTimeStr(), session.processed, session.found, session.processed - session.found, 0, session.blocksDetected);
    log(`Session logged: ${session.processed} processed, ${session.found} found`);
  }
  session.startTime = null;
  session.processed = 0;
  session.found = 0;
  session.blocksDetected = 0;
}

// ─── Process One Company ─────────────────────────────────────
async function processOneCompany() {
  if (session.manualMode !== 'running' || !session.workerRunning) return { hasMore: false, consumed: false };

  const company = db.prepare(
    `SELECT id, company_name, retry_count, last_pattern_used, last_engines_used, rejection_reason FROM companies
     WHERE status IN ('pending','retry') ORDER BY CASE WHEN status='retry' THEN 0 ELSE 1 END, id ASC LIMIT 1`
  ).get();
  if (!company) {
    log('Worker: no pending companies');
    session.currentCompany = null;
    session.idleSince = Date.now();
    return { hasMore: false, consumed: false };
  }

  try {
    session.currentCompany = { id: company.id, name: company.company_name };
    session.lastActivityAt = Date.now();
    const queryInfo = search.buildQueryForCompany(
      company.company_name,
      company.retry_count,
      company.rejection_reason,
      company.last_pattern_used
    );
    const engines = search.pickEnginesForQuery();
    log(`Worker: "${company.company_name}" [tier ${queryInfo.tier}] engines=${engines}`);

    const searchResult = await search.searchSearXNG(queryInfo.query, engines);
    const searchEmails = pickSearchEmails(searchResult.results || [], company.company_name);
    let allEmails = searchEmails.emails;
    let source = searchEmails.source;
    let sourceResults = searchResult.results || [];
    let foundSourceUrl = searchEmails.sourceUrl || sourceResults[0]?.url || null;
    let crawlFailureReason = null;

    if ((allEmails.length === 0 || source === 'search-noise') && OFFICIAL_RECOVERY_SEARCHES > 0) {
      const recoveryQueries = search.buildOfficialRecoveryQueries(company.company_name).slice(0, OFFICIAL_RECOVERY_SEARCHES);
      for (const recoveryQuery of recoveryQueries) {
        try {
          const recoveryEngines = search.pickEnginesForQuery();
          const recoveryResult = await search.searchSearXNG(recoveryQuery, recoveryEngines);
          const recoveryResults = recoveryResult.results || [];
          searchResult.results = [...(searchResult.results || []), ...recoveryResults];
          const recoveryEmails = pickSearchEmails(recoveryResults, company.company_name);
          if (recoveryEmails.emails.length > 0 && recoveryEmails.source !== 'search-noise') {
            allEmails = recoveryEmails.emails;
            source = 'official_search';
            sourceResults = recoveryResults;
            foundSourceUrl = recoveryEmails.sourceUrl || sourceResults[0]?.url || foundSourceUrl;
            log(`Worker: official recovery search found candidates for ${company.company_name}`);
            break;
          }
        } catch (e) {
          log(`Worker: official recovery search error: ${e.message}`);
        }
      }
    }

    // Fallback 1: Google CSE
    if ((allEmails.length === 0 || source === 'search-noise') && search.canUseGoogleCSE()) {
      try {
        const cseResult = await search.searchGoogleCSE(`"${company.company_name}" email ติดต่อ`);
        const cseEmails = pickSearchEmails(cseResult.results || [], company.company_name);
        if (cseEmails.emails.length > 0) {
          allEmails = cseEmails.emails;
          source = cseEmails.source === 'search-noise' ? 'google_cse_noise' : 'google_cse';
          sourceResults = cseResult.results || [];
          foundSourceUrl = cseEmails.sourceUrl || sourceResults[0]?.url || null;
        }
        else searchResult.results = [...(searchResult.results || []), ...(cseResult.results || [])];
      } catch (e) { log(`Worker: CSE error: ${e.message}`); }
    }

    // Fallback 2: Contact Page Crawl
    if ((allEmails.length === 0 || source === 'search-noise') && searchResult.results?.length > 0) {
      const crawlResult = await crawlForEmails(searchResult.results, company.company_name, company.retry_count);
      crawlFailureReason = crawlResult.reason || null;
      if (crawlResult.emails.length > 0) {
        allEmails = crawlResult.emails;
        source = crawlResult.source;
        foundSourceUrl = crawlResult.sourceUrl || foundSourceUrl;
      }
    }

    // Fallback 3: MX Guess
    if (allEmails.length === 0) {
      try {
        const mxResult = await guessEmailByMX(company.company_name);
        if (mxResult.emails.length > 0) { allEmails = mxResult.emails; source = mxResult.source; }
      } catch { /* skip */ }
    }

    let filtered = filterValidEmails(allEmails, company.company_name, source);

    // Fallback 4: ถ้า search เจอ email แต่ถูก filter หมด → ลอง crawl homepage ของ domain ที่เจอ
    if (!filtered.best && allEmails.length > 0 && searchResult.results?.length > 0) {
      try {
        const crawlResult = await crawlForEmails(searchResult.results, company.company_name, 2); // force deep crawl
        if (crawlResult.emails.length > 0) {
          const crawlFiltered = filterValidEmails(crawlResult.emails, company.company_name, crawlResult.source);
          if (crawlFiltered.best) {
            filtered = crawlFiltered;
            source = crawlResult.source;
            foundSourceUrl = crawlResult.sourceUrl || foundSourceUrl;
            log(`Worker: all_filtered recovery — found ${crawlFiltered.best} via ${source}`);
          }
        }
      } catch { /* skip */ }
    }

    const now = nowISOStr();
    const today = todayStr();
    ensureDailyStats(today);

    let status, email, sourceUrl, rejectionReason = null;
    if (filtered.best) {
      status = 'found'; email = filtered.best;
      sourceUrl = foundSourceUrl;
      session.found++;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, found = found + 1 WHERE date = ?').run(today);
    } else {
      status = 'not_found'; email = null; sourceUrl = null;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
      const hadResults = searchResult.results?.length > 0;
      const hadRawEmails = allEmails.length > 0;
      if (!hadResults) rejectionReason = REJECTION_REASONS.SEARCH_NO_RESULTS;
      else if (!hadRawEmails && source === 'search') rejectionReason = REJECTION_REASONS.SEARCH_NO_EMAILS;
      else if (!hadRawEmails) rejectionReason = crawlFailureReason || REJECTION_REASONS.CRAWL_NO_EMAILS;
      else rejectionReason = REJECTION_REASONS.ALL_FILTERED;
    }

    // เก็บทั้ง raw emails (ก่อน filter) และ filtered emails
    // ถ้า all_filtered → เก็บ raw emails ไว้เพื่อ debug + retry
    const allEmailsStr = filtered.all.length > 0
      ? filtered.all.join(', ')
      : (allEmails.length > 0 ? allEmails.join(', ') : null);

    db.prepare(`UPDATE companies SET email=?, all_emails=?, source_url=?, status=?, rejection_reason=?, last_pattern_used=?, last_engines_used=?, processed_date=?, updated_at=? WHERE id=?`)
      .run(email, allEmailsStr, sourceUrl, status, rejectionReason, queryInfo.pattern, engines, now, now, company.id);

    search.trackPatternResult(queryInfo.pattern, status === 'found');
    ab.abState.hourlyResults.push({ ts: Date.now(), found: status === 'found' });
    session.processed++;
    session.lastActivityAt = Date.now();
    session.idleSince = null;
    session.recentSpeeds.push(Date.now());
    if (session.recentSpeeds.length > 20) session.recentSpeeds.shift();
    ab.trackResult(false);

    if (session.processed % 10 === 0) { ab.checkHourlySuccessRate(); ab.checkRejectionSpike(); }

    log(`Worker: ${company.company_name} → ${status}${email ? ` (${email} via ${source})` : ''}${rejectionReason ? ` [${rejectionReason}]` : ''}`);
    search.advanceRampUp();
    session.currentCompany = null;
    return { hasMore: true, consumed: true };
  } catch (err) {
    session.lastError = { message: err.message, code: err.code || 'ERROR', at: nowISOStr() };
    session.currentCompany = null;

    if (err.code === 'ALL_ENGINES_DOWN' || err.code === 'SEARCH_BACKOFF') {
      const pauseSec = err.backoffSec || search.getAllDownBackoff();
      log(`Worker BACKOFF: ${company.company_name} — ${err.message} — pause ${pauseSec}s`);
      ab.trackResult(true);
      session.blocksDetected++;
      ensureDailyStats(todayStr());
      db.prepare('UPDATE daily_stats SET blocks_detected = blocks_detected + 1 WHERE date = ?').run(todayStr());
      db.prepare(`UPDATE companies SET status='retry', error_message=?, rejection_reason=?, updated_at=? WHERE id=?`)
        .run(err.message, REJECTION_REASONS.ENGINE_BLOCKED, nowISOStr(), company.id);
      return { hasMore: true, consumed: false, blocked: true, delaySec: pauseSec };
    }

    log(`Worker ERROR: ${company.company_name} — ${err.message}`);
    ab.trackResult(true);
    const errReason = err.message.includes('timeout') ? REJECTION_REASONS.TIMEOUT : REJECTION_REASONS.ENGINE_BLOCKED;
    const nextRetryCount = (company.retry_count || 0) + 1;
    const nextStatus = nextRetryCount >= MAX_RETRIES ? 'error' : 'retry';
    db.prepare(`UPDATE companies SET status=?, error_message=?, rejection_reason=?, retry_count=?, updated_at=? WHERE id=?`)
      .run(nextStatus, err.message, errReason, nextRetryCount, nowISOStr(), company.id);
    if (nextStatus === 'error') {
      ensureDailyStats(todayStr());
      db.prepare('UPDATE daily_stats SET processed = processed + 1, errors = errors + 1 WHERE date = ?').run(todayStr());
    }
    session.processed++;
    session.lastActivityAt = Date.now();
    session.idleSince = null;
    return { hasMore: true, consumed: true };
  }
}

// ─── Worker Loop ─────────────────────────────────────────────
async function workerLoop() {
  try {
    if (!session.workerRunning || session.manualMode !== 'running') {
      session.workerRunning = false;
      session.idleSince = Date.now();
      log('Worker stopped');
      return;
    }

  const dailyLimit = ab.getDailyLimit();
  const processedToday = getProcessedToday();

  if (processedToday >= dailyLimit) {
    ab.startLongRest();
    const stats = getDailyStats(todayStr());
    notifyLark('Daily Limit Reached', `**${formatNumber(processedToday)}/${formatNumber(dailyLimit)}** | Found: ${formatNumber(stats.found || 0)} | พัก ${Math.round(ab.workCycle.restDuration / 60000)} นาที`, 'blue');
    logSession();
    session.workerTimer = setTimeout(() => { ab.startWorkPhase(); scheduleWorkerLoop(0); }, ab.workCycle.restDuration);
    return;
  }

  if (ab.workCycle.phase === 'idle') {
    ab.startWorkPhase();
    const pendingCount = db.prepare("SELECT COUNT(*) as c FROM companies WHERE status IN ('pending','retry')").get().c;
    notifyLark('เริ่มทำงาน', `**Work Phase ${ab.workCycle.cycleCount}** — ${Math.round(ab.workCycle.workDuration / 60000)} min | Limit: ${formatNumber(dailyLimit)} | Pending: ${formatNumber(pendingCount)}`, 'green');
  }

  if (ab.isWorkPhaseExpired()) {
    ab.startRestPhase();
    const stats = getDailyStats(todayStr());
    notifyLark(`พักรอบที่ ${ab.workCycle.cycleCount}`, `ทำไป ${formatNumber(ab.workCycle.queriesThisPhase)} ราย | วันนี้: ${formatNumber(processedToday)}/${formatNumber(dailyLimit)} | Found: ${formatNumber(stats.found || 0)} | พัก ${Math.round(ab.workCycle.restDuration / 60000)} นาที`, 'yellow');
    session.workerTimer = setTimeout(() => {
      if (!session.workerRunning || session.manualMode !== 'running') { session.workerRunning = false; return; }
      ab.startWorkPhase(); scheduleWorkerLoop(0);
    }, ab.workCycle.restDuration);
    return;
  }

  const result = await processOneCompany();
  if (result.consumed) {
    ab.workCycle.queriesThisPhase++;
    ab.workCycle.totalQueriesToday++;
  }

  if (!result.hasMore) {
    session.workerRunning = false; session.manualMode = null; ab.workCycle.phase = 'idle';
    session.idleSince = Date.now();
    notifyLark('งานเสร็จ', `**ประมวลผลครบ!** วันนี้: ${formatNumber(processedToday)} | Found: ${formatNumber(session.found)}`, 'blue');
    return;
  }

  if (result.blocked) {
    session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), (result.delaySec || 300) * 1000);
    return;
  }

  if (search.getAllDownConsecutive() > 0) {
    const sec = search.getAllDownBackoff();
    session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), sec * 1000);
    return;
  }

  // Layer 1: Base delay (adaptive, includes warm-up)
  let delay = ab.getAdaptiveDelay(ab.workCycle.queriesThisPhase);
  const rampUp = search.getRampUpState();
  if (rampUp.rampUpPhase) delay *= 2;

  // Layer 2: Error backoff
  const errorCheck = ab.checkErrorBackoff();
  if (errorCheck.shouldPause) {
    session.blocksDetected++;
    ensureDailyStats(todayStr());
    db.prepare('UPDATE daily_stats SET blocks_detected = blocks_detected + 1 WHERE date = ?').run(todayStr());
    session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), errorCheck.pauseDuration * 1000);
  } else {
    session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), delay * 1000);
  }
  } catch (err) {
    session.lastError = { message: err.message, code: err.code || 'WORKER_LOOP_ERROR', at: nowISOStr() };
    session.currentCompany = null;
    log(`Worker LOOP ERROR: ${err.stack || err.message}`);
    ab.trackResult(true);
    if (session.workerRunning && session.manualMode === 'running') {
      const pauseSec = Math.min(900, Math.max(60, search.getAllDownBackoff ? search.getAllDownBackoff() : 60));
      session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), pauseSec * 1000);
    } else {
      session.workerRunning = false;
      session.idleSince = Date.now();
    }
  }
}

function scheduleWorkerLoop(delayMs = 0) {
  if (delayMs > 0) {
    session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), delayMs);
    return;
  }
  Promise.resolve(workerLoop()).catch((err) => {
    session.lastError = { message: err.message, code: err.code || 'UNHANDLED_WORKER_ERROR', at: nowISOStr() };
    log(`Worker unhandled error: ${err.stack || err.message}`);
    if (session.workerRunning && session.manualMode === 'running') {
      session.workerTimer = setTimeout(() => scheduleWorkerLoop(0), 60 * 1000);
    }
  });
}

// ─── Public API ──────────────────────────────────────────────
function start() {
  session.manualMode = 'running';
  session.manualModeSetAt = new Date().toISOString();
  session.startTime = new Date().toISOString();
  session.processed = 0; session.found = 0; session.blocksDetected = 0;
  session.lastError = null; session.idleSince = null; session.currentCompany = null;
  if (!session.workerRunning) {
    session.workerRunning = true; ab.workCycle.phase = 'idle';
    log('START — worker started'); scheduleWorkerLoop(0);
  }
}

function stop() {
  const prev = { processed: session.processed, found: session.found };
  session.manualMode = 'stopped';
  session.manualModeSetAt = new Date().toISOString();
  session.workerRunning = false; ab.workCycle.phase = 'idle';
  session.idleSince = Date.now();
  session.currentCompany = null;
  if (session.workerTimer) { clearTimeout(session.workerTimer); session.workerTimer = null; }
  notifyLark('หยุดทำงาน', `Processed: ${formatNumber(prev.processed)} | Found: ${formatNumber(prev.found)}`, 'yellow');
  log(`STOP — processed: ${prev.processed}, found: ${prev.found}`);
}

function setAuto() {
  session.manualMode = null; session.manualModeSetAt = null;
  session.workerRunning = false; ab.workCycle.phase = 'idle';
  session.idleSince = Date.now();
  session.currentCompany = null;
  if (session.workerTimer) { clearTimeout(session.workerTimer); session.workerTimer = null; }
}

function resetState() {
  session.startTime = null; session.processed = 0; session.found = 0;
  session.blocksDetected = 0; session.recentSpeeds.length = 0;
  session.lastActivityAt = null; session.lastError = null; session.idleSince = Date.now(); session.currentCompany = null;
  ab.resetAbState();
}

function getState() {
  return {
    ...session,
    sessionStartTime: session.startTime,
    sessionProcessed: session.processed,
    sessionFound: session.found,
    sessionBlocksDetected: session.blocksDetected,
  };
}

module.exports = {
  start, stop, setAuto, resetState, logSession,
  getDailyLimit: ab.getDailyLimit,
  getState,
  getWorkCycle: () => ab.workCycle,
  getRestRemaining: ab.getRestRemaining,
};
