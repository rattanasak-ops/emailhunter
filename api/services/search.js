// ─────────────────────────────────────────────────────────────
// Search Service — SearXNG + Google CSE + Engine Health
// ─────────────────────────────────────────────────────────────

const http = require('http');
const https = require('https');
const { log, todayStr } = require('../config/database');
const { notifyLark } = require('./notification');
const {
  ALL_ENGINES, ENGINE_TIERS, ENGINE_COOLDOWN_MS,
  QUERY_PATTERNS,
  ALL_DOWN_ALERT_INTERVAL, ALL_DOWN_BACKOFF_STEPS,
  RAMP_UP_QUERIES,
} = require('../config/constants');

// ─── Engine Health State ─────────────────────────────────────
const engineHealth = {};
for (const name of ALL_ENGINES) {
  engineHealth[name] = { healthy: true, lastCheck: 0, failCount: 0, suspendedUntil: 0, zeroCount: 0 };
}

const engineLastUsed = {};

// All-engines-down backoff state
let allDownConsecutive = 0;
let allDownLastAlertAt = 0;

// Gradual ramp-up after recovery
let rampUpPhase = false;
let rampUpQueriesDone = 0;

function getAllDownBackoff() {
  const idx = Math.min(allDownConsecutive - 1, ALL_DOWN_BACKOFF_STEPS.length - 1);
  return ALL_DOWN_BACKOFF_STEPS[Math.max(0, idx)];
}

function markEngineUnhealthy(engineName, durationMs = 30 * 60 * 1000) {
  const eng = engineHealth[engineName];
  if (!eng) return;
  const wasHealthy = eng.healthy;
  eng.healthy = false;
  eng.failCount++;
  const backoff = Math.min(durationMs + (eng.failCount - 1) * 5 * 60 * 1000, 20 * 60 * 1000);
  eng.suspendedUntil = Date.now() + backoff;
  log(`Engine ${engineName} marked UNHEALTHY — suspended for ${Math.round(backoff / 60000)} min (fail #${eng.failCount})`);

  if (wasHealthy) {
    const healthy = getHealthyEngines();
    notifyLark(`Engine Down: ${engineName}`, [
      `**${engineName}** ถูก block/suspended`,
      `Healthy engines: ${healthy.length > 0 ? healthy.join(', ') : 'ไม่มี!'}`,
      `จะลอง recover ใน ${Math.round(backoff / 60000)} นาที`,
      healthy.length === 0 ? '🚨 **ทุก engine ถูก block — ควร restart SearXNG หรือเปลี่ยน IP**' : '',
    ].filter(Boolean).join('\n'), healthy.length === 0 ? 'red' : 'yellow');
  }
}

function markEngineHealthy(engineName) {
  const eng = engineHealth[engineName];
  if (!eng) return;
  if (!eng.healthy) log(`Engine ${engineName} recovered — marking HEALTHY`);
  eng.healthy = true;
  eng.failCount = 0;
  eng.suspendedUntil = 0;
  eng.lastCheck = Date.now();
  eng.zeroCount = 0;
}

function getHealthyEngines() {
  const now = Date.now();
  const healthy = [];
  for (const [name, status] of Object.entries(engineHealth)) {
    if (!status.healthy && now >= status.suspendedUntil) {
      status.healthy = true;
      log(`Engine ${name} suspension expired — auto-recovered`);
    }
    if (status.healthy) healthy.push(name);
  }
  return healthy;
}

// ─── Engine Selection — Tier-based with cooldown ─────────────

function pickEnginesForQuery() {
  const healthy = getHealthyEngines();
  const now = Date.now();

  if (healthy.length === 0) {
    log('WARNING: All engines unhealthy — fallback to bing,duckduckgo');
    return 'bing,duckduckgo';
  }

  const scored = healthy.map(eng => ({
    name: eng,
    idleMs: now - (engineLastUsed[eng] || 0),
    cooldownOk: (now - (engineLastUsed[eng] || 0)) >= ENGINE_COOLDOWN_MS,
  }));

  const available = scored.filter(e => e.cooldownOk).sort((a, b) => b.idleMs - a.idleMs);
  // ใช้ 2 engines ต่อ query (ลดจาก 3) → กระจาย load ไม่ให้ engine ไหนถูกยิงถี่เกิน
  const count = Math.min(2, healthy.length);
  const picked = [];

  for (const tier of [ENGINE_TIERS.primary, ENGINE_TIERS.secondary, ENGINE_TIERS.tertiary]) {
    if (picked.length >= count) break;
    const tierAvailable = available.filter(e => tier.includes(e.name) && !picked.includes(e.name));
    if (tierAvailable.length > 0) picked.push(tierAvailable[0].name);
  }

  for (const eng of available) {
    if (picked.length >= count) break;
    if (!picked.includes(eng.name)) picked.push(eng.name);
  }

  const onCooldown = scored.filter(e => !e.cooldownOk).sort((a, b) => b.idleMs - a.idleMs);
  for (const eng of onCooldown) {
    if (picked.length >= count) break;
    if (!picked.includes(eng.name)) picked.push(eng.name);
  }

  for (const eng of picked) engineLastUsed[eng] = now;
  return picked.join(',');
}

// ─── Query Builder — Weighted random selection ───────────────

const patternStats = {};

function trackPatternResult(patternStr, found) {
  if (!patternStats[patternStr]) patternStats[patternStr] = { used: 0, found: 0 };
  patternStats[patternStr].used++;
  if (found) patternStats[patternStr].found++;
}

function getEffectiveWeight(pattern) {
  const stats = patternStats[pattern.pattern];
  if (!stats || stats.used < 5) return pattern.weight; // ยังไม่มีข้อมูลพอ → ใช้ default
  const successRate = stats.found / stats.used;
  // ปรับ weight: pattern ที่ found rate สูง → weight x2, ต่ำ → weight x0.3
  if (successRate > 0.4) return pattern.weight * 2.0;
  if (successRate > 0.25) return pattern.weight * 1.5;
  if (successRate > 0.10) return pattern.weight * 1.0;
  if (successRate > 0.05) return pattern.weight * 0.5;
  return pattern.weight * 0.3; // pattern ที่แทบไม่เคยหาเจอ → ลด weight มาก
}

function buildQuery(companyName, excludePattern) {
  // คำนวณ effective weights ตาม performance จริง
  const weighted = QUERY_PATTERNS.map(p => ({ ...p, effectiveWeight: getEffectiveWeight(p) }));
  const totalWeight = weighted.reduce((sum, p) => sum + p.effectiveWeight, 0);
  let selected = weighted[0];

  for (let attempt = 0; attempt < 5; attempt++) {
    let rand = Math.random() * totalWeight;
    for (const p of weighted) {
      rand -= p.effectiveWeight;
      if (rand <= 0) { selected = p; break; }
    }
    if (!excludePattern || selected.pattern !== excludePattern) break;
  }

  return {
    query: selected.pattern.replace(/\{company\}/g, companyName),
    pattern: selected.pattern,
    tier: selected.tier,
  };
}

// ─── SearXNG Search ──────────────────────────────────────────

function searchSearXNG(query, engines) {
  return new Promise((resolve, reject) => {
    const url = `http://emailhunter-searxng:8080/search?q=${encodeURIComponent(query)}&format=json&engines=${engines}`;
    http.get(url, { timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          const unresponsiveNames = (parsed.unresponsive_engines || []).map(e => e[0]);
          const respondedEngines = (parsed.results || []).flatMap(r => r.engines || []);
          const uniqueResponded = [...new Set(respondedEngines)];

          for (const [engName] of (parsed.unresponsive_engines || [])) {
            const eh = engineHealth[engName];
            if (eh) { eh.failCount++; eh.healthy = false; eh.lastCheck = Date.now(); }
          }
          for (const eng of uniqueResponded) {
            const eh = engineHealth[eng];
            if (eh) { eh.healthy = true; eh.failCount = 0; eh.lastCheck = Date.now(); }
          }

          if (unresponsiveNames.length >= 2 && uniqueResponded.length === 0) {
            allDownConsecutive++;
            const backoffSec = getAllDownBackoff();
            const reasons = (parsed.unresponsive_engines || []).map(e => `${e[0]}: ${e[1]}`).join(', ');
            log(`SearXNG: ALL engines down (#${allDownConsecutive}) — backoff ${backoffSec}s — ${reasons}`);

            if (Date.now() - allDownLastAlertAt >= ALL_DOWN_ALERT_INTERVAL) {
              allDownLastAlertAt = Date.now();
              notifyLark('ALL Engines Down', [
                '**ทุก search engine ถูก block พร้อมกัน**',
                `Engines: ${reasons}`,
                `Backoff: ${backoffSec}s (ครั้งที่ ${allDownConsecutive})`,
                'ระบบจะพักแล้วลองใหม่อัตโนมัติ',
              ].join('\n'), 'red');
            }
          }

          if (uniqueResponded.length > 0 && allDownConsecutive > 0) {
            log(`SearXNG: engines recovered after ${allDownConsecutive} failures — entering ramp-up phase`);
            allDownConsecutive = 0;
            rampUpPhase = true;
            rampUpQueriesDone = 0;
            notifyLark('Engines Recovered', [
              `**Engine กลับมาแล้ว:** ${uniqueResponded.join(', ')}`,
              `Ramp-up: ${RAMP_UP_QUERIES} queries แรกจะช้ากว่าปกติ 2x`,
            ].join('\n'), 'green');
          }

          if (unresponsiveNames.length > 0 && uniqueResponded.length > 0) {
            log(`SearXNG: ${unresponsiveNames.join(',')} blocked, but ${uniqueResponded.join(',')} responded OK`);
          }

          resolve(parsed);
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

// ─── Google CSE — Multi-key rotation ─────────────────────────

const GOOGLE_CSE_KEYS = (process.env.GOOGLE_CSE_API_KEYS || process.env.GOOGLE_CSE_API_KEY || '')
  .split(',').map(k => k.trim()).filter(Boolean);
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';
const GOOGLE_CSE_LIMIT_PER_KEY = 95;
const cseKeyUsage = {};
let cseResetDate = todayStr();

function resetCseCounters() {
  const today = todayStr();
  if (today !== cseResetDate) {
    for (const key of Object.keys(cseKeyUsage)) cseKeyUsage[key] = 0;
    cseResetDate = today;
    log(`Google CSE daily counters reset (${today}) — ${GOOGLE_CSE_KEYS.length} keys`);
  }
}

function getAvailableCseKey() {
  resetCseCounters();
  for (const key of GOOGLE_CSE_KEYS) {
    const used = cseKeyUsage[key] || 0;
    if (used < GOOGLE_CSE_LIMIT_PER_KEY) return key;
  }
  return null;
}

function canUseGoogleCSE() {
  return GOOGLE_CSE_CX && getAvailableCseKey() !== null;
}

function getCseTotalUsedToday() {
  return Object.values(cseKeyUsage).reduce((a, b) => a + b, 0);
}

function searchGoogleCSE(query) {
  return new Promise((resolve, reject) => {
    const apiKey = getAvailableCseKey();
    if (!apiKey) return reject(new Error('No available CSE API key'));

    const params = new URLSearchParams({
      key: apiKey, cx: GOOGLE_CSE_CX, q: query, num: '10', lr: 'lang_th',
    });
    const url = `https://www.googleapis.com/customsearch/v1?${params}`;

    https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) { log(`Google CSE error: ${json.error.message}`); return reject(new Error(json.error.message)); }
          cseKeyUsage[apiKey] = (cseKeyUsage[apiKey] || 0) + 1;
          const results = (json.items || []).map(item => ({
            title: item.title || '', url: item.link || '', content: item.snippet || '', engines: ['google_cse'],
          }));
          const totalUsed = getCseTotalUsedToday();
          const totalLimit = GOOGLE_CSE_KEYS.length * GOOGLE_CSE_LIMIT_PER_KEY;
          log(`Google CSE: ${results.length} results (${totalUsed}/${totalLimit} today, key ${GOOGLE_CSE_KEYS.indexOf(apiKey) + 1}/${GOOGLE_CSE_KEYS.length})`);
          resolve({ results });
        } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(); reject(new Error('timeout')); });
  });
}

module.exports = {
  // Engine health
  engineHealth,
  markEngineHealthy,
  markEngineUnhealthy,
  getHealthyEngines,
  pickEnginesForQuery,
  // Search
  searchSearXNG,
  searchGoogleCSE,
  canUseGoogleCSE,
  getCseTotalUsedToday,
  GOOGLE_CSE_KEYS,
  GOOGLE_CSE_LIMIT_PER_KEY,
  // Query
  buildQuery,
  patternStats,
  trackPatternResult,
  // Backoff state
  getAllDownConsecutive: () => allDownConsecutive,
  getRampUpState: () => ({ rampUpPhase, rampUpQueriesDone }),
  advanceRampUp: () => { rampUpQueriesDone++; if (rampUpQueriesDone >= RAMP_UP_QUERIES) { rampUpPhase = false; log('Ramp-up complete — returning to normal speed'); } },
  resetAllDown: () => { allDownConsecutive = 0; },
  getAllDownBackoff,
};
