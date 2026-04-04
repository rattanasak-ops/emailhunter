// ─────────────────────────────────────────────────────────────
// Worker Service — Processing loop + State management
// ─────────────────────────────────────────────────────────────

const { db, log, todayStr, nowTimeStr, nowISOStr, ensureDailyStats, getDailyStats, getProcessedToday, formatNumber, randomBetween } = require('../config/database');
const { REJECTION_REASONS } = require('../config/constants');
const { notifyLark } = require('./notification');
const search = require('./search');
const { extractEmails, crawlForEmails, guessEmailByMX } = require('./crawler');
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
};

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
  if (session.manualMode !== 'running' || !session.workerRunning) return false;

  const company = db.prepare(
    `SELECT id, company_name, retry_count, last_pattern_used, last_engines_used, rejection_reason FROM companies
     WHERE status IN ('pending','retry') ORDER BY CASE WHEN status='retry' THEN 0 ELSE 1 END, id ASC LIMIT 1`
  ).get();
  if (!company) { log('Worker: no pending companies'); return false; }

  try {
    // Smart retry: ถ้า retry ครั้งที่ 2+ → บังคับใช้ directory/social patterns (tier 5-6)
    const forceDirectoryTier = company.retry_count >= 1 && company.rejection_reason !== 'engine_blocked';
    const queryInfo = forceDirectoryTier
      ? search.buildQueryFromTier(company.company_name, [5, 6], company.last_pattern_used)
      : search.buildQuery(company.company_name, company.last_pattern_used);
    const engines = search.pickEnginesForQuery();
    log(`Worker: "${company.company_name}" [tier ${queryInfo.tier}] engines=${engines}`);

    const searchResult = await search.searchSearXNG(queryInfo.query, engines);
    let allEmails = extractEmails(searchResult.results || []);
    let source = 'search';

    // Fallback 1: Google CSE
    if (allEmails.length === 0 && search.canUseGoogleCSE()) {
      try {
        const cseResult = await search.searchGoogleCSE(`"${company.company_name}" email ติดต่อ`);
        const cseEmails = extractEmails(cseResult.results || []);
        if (cseEmails.length > 0) { allEmails = cseEmails; source = 'google_cse'; }
        else searchResult.results = [...(searchResult.results || []), ...(cseResult.results || [])];
      } catch (e) { log(`Worker: CSE error: ${e.message}`); }
    }

    // Fallback 2: Contact Page Crawl
    if (allEmails.length === 0 && searchResult.results?.length > 0) {
      const crawlResult = await crawlForEmails(searchResult.results, company.company_name, company.retry_count);
      if (crawlResult.emails.length > 0) { allEmails = crawlResult.emails; source = crawlResult.source; }
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
      sourceUrl = searchResult.results?.[0]?.url || null;
      session.found++;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, found = found + 1 WHERE date = ?').run(today);
    } else {
      status = 'not_found'; email = null; sourceUrl = null;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
      const hadResults = searchResult.results?.length > 0;
      const hadRawEmails = allEmails.length > 0;
      if (!hadResults) rejectionReason = REJECTION_REASONS.SEARCH_NO_RESULTS;
      else if (!hadRawEmails && source === 'search') rejectionReason = REJECTION_REASONS.SEARCH_NO_EMAILS;
      else if (!hadRawEmails) rejectionReason = REJECTION_REASONS.CRAWL_NO_EMAILS;
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
    session.recentSpeeds.push(Date.now());
    if (session.recentSpeeds.length > 20) session.recentSpeeds.shift();
    ab.trackResult(false);

    if (session.processed % 10 === 0) { ab.checkHourlySuccessRate(); ab.checkRejectionSpike(); }

    log(`Worker: ${company.company_name} → ${status}${email ? ` (${email} via ${source})` : ''}${rejectionReason ? ` [${rejectionReason}]` : ''}`);
    return true;
  } catch (err) {
    log(`Worker ERROR: ${company.company_name} — ${err.message}`);
    ab.trackResult(true);
    const errReason = err.message.includes('timeout') ? REJECTION_REASONS.TIMEOUT : REJECTION_REASONS.ENGINE_BLOCKED;
    db.prepare(`UPDATE companies SET status='retry', error_message=?, rejection_reason=?, retry_count=retry_count+1, updated_at=? WHERE id=?`)
      .run(err.message, errReason, nowISOStr(), company.id);
    session.processed++;
    return true;
  }
}

// ─── Worker Loop ─────────────────────────────────────────────
async function workerLoop() {
  if (!session.workerRunning || session.manualMode !== 'running') {
    session.workerRunning = false; log('Worker stopped'); return;
  }

  const dailyLimit = ab.getDailyLimit();
  const processedToday = getProcessedToday();

  if (processedToday >= dailyLimit) {
    ab.startLongRest();
    const stats = getDailyStats(todayStr());
    notifyLark('Daily Limit Reached', `**${formatNumber(processedToday)}/${formatNumber(dailyLimit)}** | Found: ${formatNumber(stats.found || 0)} | พัก ${Math.round(ab.workCycle.restDuration / 60000)} นาที`, 'blue');
    logSession();
    session.workerTimer = setTimeout(() => { ab.startWorkPhase(); workerLoop(); }, ab.workCycle.restDuration);
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
      ab.startWorkPhase(); workerLoop();
    }, ab.workCycle.restDuration);
    return;
  }

  const hasMore = await processOneCompany();
  ab.workCycle.queriesThisPhase++;
  ab.workCycle.totalQueriesToday++;

  if (!hasMore) {
    session.workerRunning = false; session.manualMode = null; ab.workCycle.phase = 'idle';
    notifyLark('งานเสร็จ', `**ประมวลผลครบ!** วันนี้: ${formatNumber(processedToday)} | Found: ${formatNumber(session.found)}`, 'blue');
    return;
  }

  if (search.getAllDownConsecutive() > 0) {
    const sec = search.getAllDownBackoff();
    session.workerTimer = setTimeout(workerLoop, sec * 1000);
    return;
  }

  // Layer 1: Base delay (adaptive, includes warm-up)
  const delay = ab.getAdaptiveDelay(ab.workCycle.queriesThisPhase);

  // Layer 2: Error backoff
  const errorCheck = ab.checkErrorBackoff();
  if (errorCheck.shouldPause) {
    session.blocksDetected++;
    ensureDailyStats(todayStr());
    db.prepare('UPDATE daily_stats SET blocks_detected = blocks_detected + 1 WHERE date = ?').run(todayStr());
    session.workerTimer = setTimeout(workerLoop, errorCheck.pauseDuration * 1000);
  } else {
    session.workerTimer = setTimeout(workerLoop, delay * 1000);
  }
}

// ─── Public API ──────────────────────────────────────────────
function start() {
  session.manualMode = 'running';
  session.manualModeSetAt = new Date().toISOString();
  session.startTime = new Date().toISOString();
  session.processed = 0; session.found = 0; session.blocksDetected = 0;
  if (!session.workerRunning) {
    session.workerRunning = true; ab.workCycle.phase = 'idle';
    log('START — worker started'); workerLoop();
  }
}

function stop() {
  const prev = { processed: session.processed, found: session.found };
  session.manualMode = 'stopped';
  session.manualModeSetAt = new Date().toISOString();
  session.workerRunning = false; ab.workCycle.phase = 'idle';
  if (session.workerTimer) { clearTimeout(session.workerTimer); session.workerTimer = null; }
  notifyLark('หยุดทำงาน', `Processed: ${formatNumber(prev.processed)} | Found: ${formatNumber(prev.found)}`, 'yellow');
  log(`STOP — processed: ${prev.processed}, found: ${prev.found}`);
}

function setAuto() {
  session.manualMode = null; session.manualModeSetAt = null;
  session.workerRunning = false; ab.workCycle.phase = 'idle';
  if (session.workerTimer) { clearTimeout(session.workerTimer); session.workerTimer = null; }
}

function resetState() {
  session.startTime = null; session.processed = 0; session.found = 0;
  session.blocksDetected = 0; session.recentSpeeds.length = 0;
  ab.resetAbState();
}

module.exports = {
  start, stop, setAuto, resetState, logSession,
  getDailyLimit: ab.getDailyLimit,
  getState: () => session,
  getWorkCycle: () => ab.workCycle,
  getRestRemaining: ab.getRestRemaining,
};
