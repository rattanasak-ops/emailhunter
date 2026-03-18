// ─────────────────────────────────────────────────────────────
// EmailHunter API — v2.0.0
// Production backend service with anti-blocking engine
// ─────────────────────────────────────────────────────────────

process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');

const app = express();
const PORT = 3456;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Logging helper ──────────────────────────────────────────
function log(msg) {
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  console.log(`[${now}] ${msg}`);
}

// ─── SQLite Setup ────────────────────────────────────────────
const DATA_DIR = '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'emailhunter.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company_name TEXT NOT NULL,
    tax_id TEXT,
    industry TEXT,
    status TEXT DEFAULT 'pending',
    email TEXT,
    all_emails TEXT,
    source_url TEXT,
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    processed_date TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_status ON companies(status);

  CREATE TABLE IF NOT EXISTS daily_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE NOT NULL,
    processed INTEGER DEFAULT 0,
    found INTEGER DEFAULT 0,
    not_found INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    blocks_detected INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    start_time TEXT,
    end_time TEXT,
    processed INTEGER DEFAULT 0,
    found INTEGER DEFAULT 0,
    not_found INTEGER DEFAULT 0,
    errors INTEGER DEFAULT 0,
    blocks_detected INTEGER DEFAULT 0
  );
`);

log('Database initialized');

// ─── Migration: เปลี่ยน idx_company_name เป็น UNIQUE (ป้องกัน import ซ้ำ) ───
try {
  const idxInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_company_name'").get();
  if (!idxInfo || !idxInfo.sql || !idxInfo.sql.includes('UNIQUE')) {
    // ลบ duplicate ก่อน — เก็บ row ที่มี status ดีที่สุด (found > not_found > pending)
    const dupeCount = db.prepare("SELECT COUNT(*) as c FROM (SELECT company_name FROM companies GROUP BY company_name HAVING COUNT(*) > 1)").get().c;
    if (dupeCount > 0) {
      log(`Found ${dupeCount} duplicate company names — removing duplicates...`);
      db.exec(`
        DELETE FROM companies WHERE id NOT IN (
          SELECT MIN(CASE WHEN status IN ('found','done') THEN id ELSE 999999999 END)
          FROM companies GROUP BY company_name
        ) AND company_name IN (
          SELECT company_name FROM companies GROUP BY company_name HAVING COUNT(*) > 1
        )
      `);
      // fallback: ถ้ายังมี duplicate (ไม่มี row ที่ found) เก็บ id ต่ำสุด
      db.exec(`
        DELETE FROM companies WHERE id NOT IN (
          SELECT MIN(id) FROM companies GROUP BY company_name
        )
      `);
      const remaining = db.prepare("SELECT COUNT(*) as c FROM companies").get().c;
      log(`Duplicates removed. Remaining: ${remaining} companies`);
    }
    log('Migrating idx_company_name to UNIQUE...');
    db.exec('DROP INDEX IF EXISTS idx_company_name');
    db.exec('CREATE UNIQUE INDEX idx_company_name ON companies(company_name)');
    log('Migration complete: idx_company_name is now UNIQUE');
  }
} catch (e) {
  log(`Migration warning: ${e.message}`);
}

// ─── Auto-sync daily_stats on startup ────────────────────────
// ถ้า daily_stats ไม่ตรงกับ companies table → backfill อัตโนมัติ
(function autoSyncDailyStats() {
  try {
    const companyTotal = db.prepare('SELECT COUNT(*) as cnt FROM companies WHERE status IN ("found","done","not_found","error")').get().cnt;
    const statsTotal = db.prepare('SELECT COALESCE(SUM(processed),0) as cnt FROM daily_stats').get().cnt;

    if (companyTotal > 0 && Math.abs(companyTotal - statsTotal) > 10) {
      log(`daily_stats out of sync (companies: ${companyTotal}, stats: ${statsTotal}) — backfilling...`);

      const rows = db.prepare(`
        SELECT DATE(processed_date) as date,
               COUNT(*) as processed,
               SUM(CASE WHEN status IN ('found','done') AND email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as found,
               SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) as not_found,
               SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
        FROM companies
        WHERE processed_date IS NOT NULL
        GROUP BY DATE(processed_date)
      `).all();

      const upsert = db.prepare(`
        INSERT INTO daily_stats (date, processed, found, not_found, errors)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(date) DO UPDATE SET
          processed = excluded.processed,
          found = excluded.found,
          not_found = excluded.not_found,
          errors = excluded.errors
      `);

      const tx = db.transaction(() => {
        for (const r of rows) {
          if (r.date) upsert.run(r.date, r.processed, r.found, r.not_found, r.errors);
        }
      });
      tx();

      log(`daily_stats backfilled: ${rows.length} dates synced`);
    } else {
      log('daily_stats in sync');
    }
  } catch (err) {
    log(`daily_stats sync error: ${err.message}`);
  }
})();

// ─── Anti-Blocking Engine ────────────────────────────────────

// 1. Query Variation — 8+ patterns
const QUERY_PATTERNS = [
  '"{company}" email ติดต่อ',
  '"{company}" อีเมล',
  '"{company}" contact email',
  '{company} email address',
  '{company} site:*.co.th email',
  '"ติดต่อ {company}" email',
  '{company} อีเมล ติดต่อ สอบถาม',
  '{company} email @',
  '"{company}" อีเมล์ ติดต่อเรา',
  '{company} contact us email address',
];

function buildQuery(companyName) {
  const pattern = QUERY_PATTERNS[Math.floor(Math.random() * QUERY_PATTERNS.length)];
  return pattern.replace(/\{company\}/g, companyName);
}

// 2. Engine Rotation — never same engine 3 times in a row
const ENGINE_OPTIONS = [
  'google',
  'bing',
  'duckduckgo',
  'google,bing',
  'bing,duckduckgo',
  'duckduckgo,google',
];
const lastEngines = []; // track last 3

function pickEngine() {
  let candidates = [...ENGINE_OPTIONS];

  // If last 2 engines are the same, exclude that engine
  if (lastEngines.length >= 2 && lastEngines[lastEngines.length - 1] === lastEngines[lastEngines.length - 2]) {
    const repeated = lastEngines[lastEngines.length - 1];
    candidates = candidates.filter(e => e !== repeated);
  }

  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  lastEngines.push(chosen);
  if (lastEngines.length > 3) lastEngines.shift();
  return chosen;
}

// 3. Gaussian Random Delay — Box-Muller transform
function gaussianDelay(mean = 12, stddev = 4, min = 6, max = 25) {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const value = mean + z * stddev;
  return Math.round(Math.min(max, Math.max(min, value)) * 10) / 10;
}

// 4. Session Breaks — "Coffee breaks"
let queriesSinceBreak = 0;
let nextBreakAt = randomBetween(30, 60);

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function checkSessionBreak() {
  queriesSinceBreak++;
  if (queriesSinceBreak >= nextBreakAt) {
    const pauseDuration = randomBetween(120, 300);
    queriesSinceBreak = 0;
    nextBreakAt = randomBetween(30, 60);
    log(`Coffee break! Pausing for ${pauseDuration}s after ${nextBreakAt} queries`);
    return { shouldPause: true, pauseDuration };
  }
  return { shouldPause: false, pauseDuration: 0, queriesUntilBreak: nextBreakAt - queriesSinceBreak };
}

// 5. Error Spike Detection — Circular buffer of last 20
const ERROR_BUFFER_SIZE = 20;
const errorBuffer = []; // true = error, false = success

function trackResult(isError) {
  errorBuffer.push(isError);
  if (errorBuffer.length > ERROR_BUFFER_SIZE) errorBuffer.shift();
}

function checkErrorSpike() {
  if (errorBuffer.length < 5) return { shouldPause: false, pauseDuration: 0 };

  const errorCount = errorBuffer.filter(Boolean).length;
  const errorRate = errorCount / errorBuffer.length;

  if (errorRate > 0.5) {
    const pauseDuration = randomBetween(600, 900);
    log(`CRITICAL: Error rate ${(errorRate * 100).toFixed(0)}% — pausing ${pauseDuration}s`);
    errorBuffer.length = 0; // reset after pause
    return { shouldPause: true, pauseDuration };
  }
  if (errorRate > 0.3) {
    const pauseDuration = randomBetween(300, 600);
    log(`WARNING: Error rate ${(errorRate * 100).toFixed(0)}% — pausing ${pauseDuration}s`);
    errorBuffer.length = 0;
    return { shouldPause: true, pauseDuration };
  }
  return { shouldPause: false, pauseDuration: 0 };
}

// 6. Daily Limits — สุ่มใหม่ทุกวัน
let DAILY_LIMIT = randomBetween(4000, 4800);
let dailyLimitDate = todayStr();

function getDailyLimit() {
  const today = todayStr();
  if (today !== dailyLimitDate) {
    DAILY_LIMIT = randomBetween(4000, 4800);
    dailyLimitDate = today;
    log(`New daily limit: ${DAILY_LIMIT} (randomized)`);
  }
  return DAILY_LIMIT;
}

// 7. Adaptive Delay — ปรับ delay ตาม error rate อัตโนมัติ
let adaptiveDelayMean = 12;

function getAdaptiveDelay() {
  const errRate = errorBuffer.length >= 5 ? errorBuffer.filter(Boolean).length / errorBuffer.length : 0;
  if (errRate > 0.5) adaptiveDelayMean = 25;
  else if (errRate > 0.35) adaptiveDelayMean = 20;
  else if (errRate > 0.2) adaptiveDelayMean = 15;
  else adaptiveDelayMean = 12;
  return gaussianDelay(adaptiveDelayMean, 4, 6, 35);
}

// ─── Work Cycle System — ทำงานเหมือนคนจริง ──────────────────
// Work Phase: ทำงาน 45-65 นาที → Rest Phase: พัก 15-30 นาที → วนซ้ำ
const workCycle = {
  phase: 'idle',         // 'working' | 'resting' | 'idle' | 'long_rest'
  cycleCount: 0,         // รอบที่เท่าไหร่
  phaseStart: null,      // timestamp เริ่มต้น phase ปัจจุบัน
  workDuration: 0,       // ms — ระยะทำงาน phase นี้
  restDuration: 0,       // ms — ระยะพัก phase นี้
  queriesThisPhase: 0,   // queries ใน phase นี้
  totalQueriesToday: 0,   // queries ทั้งวัน
  todayDate: todayStr(),  // track วันที่เพื่อ reset
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
  workCycle.workDuration = randomBetween(45, 65) * 60 * 1000; // 45-65 นาที
  workCycle.queriesThisPhase = 0;
  log(`Work Phase ${workCycle.cycleCount} started — duration ${Math.round(workCycle.workDuration / 60000)} min`);
}

function startRestPhase() {
  workCycle.phase = 'resting';
  workCycle.phaseStart = Date.now();
  workCycle.restDuration = randomBetween(15, 30) * 60 * 1000; // 15-30 นาที
  log(`Rest Phase started — duration ${Math.round(workCycle.restDuration / 60000)} min`);
}

function startLongRest() {
  workCycle.phase = 'long_rest';
  workCycle.phaseStart = Date.now();
  workCycle.restDuration = randomBetween(120, 240) * 60 * 1000; // 2-4 ชั่วโมง
  log(`Long Rest (daily limit reached) — duration ${Math.round(workCycle.restDuration / 60000)} min`);
}

function checkWorkCycle() {
  if (workCycle.phase !== 'working') return { shouldRest: false };

  const elapsed = Date.now() - workCycle.phaseStart;
  const remaining = workCycle.workDuration - elapsed;

  if (remaining <= 0) {
    return { shouldRest: true };
  }
  return { shouldRest: false, remainingMs: remaining };
}

function isRestComplete() {
  if (workCycle.phase !== 'resting' && workCycle.phase !== 'long_rest') return true;
  const elapsed = Date.now() - workCycle.phaseStart;
  return elapsed >= workCycle.restDuration;
}

function getRestRemaining() {
  if (workCycle.phase !== 'resting' && workCycle.phase !== 'long_rest') return 0;
  const elapsed = Date.now() - workCycle.phaseStart;
  return Math.max(0, workCycle.restDuration - elapsed);
}

// Slow start — กลับมาจากพัก delay x1.5 ใน 5 queries แรก
function getSlowStartMultiplier() {
  if (workCycle.queriesThisPhase < 5) return 1.5;
  return 1.0;
}

// ─── Session tracking ────────────────────────────────────────
let sessionStartTime = null;
let sessionProcessed = 0;
let sessionFound = 0;
let sessionBlocksDetected = 0;
const recentSpeeds = []; // timestamps of last 20 results for speed calc

// ─── Manual Override Control ─────────────────────────────────
let manualMode = null; // null = auto (schedule), 'running' = force run, 'stopped' = force stop
let manualModeSetAt = null;

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
}

function nowTimeStr() {
  return new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
}

function isWithinSchedule() {
  const hour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false });
  const h = parseInt(hour, 10);
  return h >= 1 && h < 9;
}

function ensureDailyStats(date) {
  const existing = db.prepare('SELECT id FROM daily_stats WHERE date = ?').get(date);
  if (!existing) {
    db.prepare('INSERT INTO daily_stats (date) VALUES (?)').run(date);
  }
}

function getDailyStats(date) {
  ensureDailyStats(date);
  return db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(date);
}

function getProcessedToday() {
  const stats = getDailyStats(todayStr());
  return stats ? stats.processed : 0;
}

// ─── Multer setup ────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 200 * 1024 * 1024 }, // 200MB
});

// ─── API Endpoints ───────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM companies').get();
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      db_size: row.cnt,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// Get next pending company with anti-block config
app.get('/api/companies/next', (req, res) => {
  try {
    const processedToday = getProcessedToday();
    const dailyLimit = getDailyLimit();
    const forceRun = req.query.force === 'true' || manualMode === 'running';
    const forceStop = manualMode === 'stopped';
    const shouldStop = forceStop || (!forceRun || processedToday >= dailyLimit);

    // Find next pending (or retry) company
    const company = db.prepare(
      `SELECT id, company_name, tax_id, industry, retry_count
       FROM companies
       WHERE status IN ('pending', 'retry')
       ORDER BY
         CASE WHEN status = 'retry' THEN 0 ELSE 1 END,
         id ASC
       LIMIT 1`
    ).get();

    if (!company) {
      // Log session when stopping due to no pending companies
      if (sessionStartTime && sessionProcessed > 0) {
        db.prepare(`
          INSERT INTO session_log (start_time, end_time, processed, found, not_found, errors, blocks_detected)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sessionStartTime, nowTimeStr(), sessionProcessed, sessionFound, sessionProcessed - sessionFound, 0, sessionBlocksDetected);
        log(`Session logged: ${sessionProcessed} processed, ${sessionFound} found`);
        sessionStartTime = null;
        sessionProcessed = 0;
        sessionFound = 0;
        sessionBlocksDetected = 0;
      }
      return res.json({
        company: null,
        session: { should_stop: true, reason: 'no_pending' },
      });
    }

    if (shouldStop) {
      // Log session when stopping due to schedule/limit
      if (sessionStartTime && sessionProcessed > 0) {
        db.prepare(`
          INSERT INTO session_log (start_time, end_time, processed, found, not_found, errors, blocks_detected)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(sessionStartTime, nowTimeStr(), sessionProcessed, sessionFound, sessionProcessed - sessionFound, 0, sessionBlocksDetected);
        log(`Session logged: ${sessionProcessed} processed, ${sessionFound} found`);
        sessionStartTime = null;
        sessionProcessed = 0;
        sessionFound = 0;
        sessionBlocksDetected = 0;
      }
      return res.json({
        company: null,
        session: {
          should_stop: true,
          reason: processedToday >= dailyLimit ? 'daily_limit' : 'not_running',
          processed_today: processedToday,
        },
      });
    }

    // Start session if not started
    if (!sessionStartTime) {
      sessionStartTime = nowTimeStr();
      sessionProcessed = 0;
      sessionFound = 0;
      sessionBlocksDetected = 0;
      log('New session started');
    }

    // Anti-blocking: build search config
    const query = buildQuery(company.company_name);
    const engines = pickEngine();
    const delay = getAdaptiveDelay() * getSlowStartMultiplier();
    const breakCheck = checkSessionBreak();
    const errorCheck = checkErrorSpike();

    // Merge pause decisions (take the longer pause)
    let shouldPause = breakCheck.shouldPause || errorCheck.shouldPause;
    let pauseDuration = Math.max(breakCheck.pauseDuration, errorCheck.pauseDuration);

    if (errorCheck.shouldPause) {
      sessionBlocksDetected++;
      // Update daily_stats blocks
      ensureDailyStats(todayStr());
      db.prepare('UPDATE daily_stats SET blocks_detected = blocks_detected + 1 WHERE date = ?').run(todayStr());
    }

    res.json({
      company: { id: company.id, company_name: company.company_name },
      search: {
        query,
        engines,
        delay,
        shouldPause,
        pauseDuration,
      },
      session: {
        processed_today: processedToday,
        is_within_schedule: withinSchedule,
        should_stop: false,
        queries_until_break: breakCheck.queriesUntilBreak || (nextBreakAt - queriesSinceBreak),
      },
    });
  } catch (err) {
    log(`ERROR /api/companies/next: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Email Quality Filter ────────────────────────────────────
// Blacklisted domains: directory sites, job boards, data aggregators, unrelated companies
const BLACKLIST_DOMAINS = [
  // Directory & data sites
  'connectbizs.com', 'longdo.com', 'yellowpages.co.th', 'trustonline.co.th',
  'thaidbs.com', 'thaibizdir.com', 'registered.in.th', 'dataforthai.com',
  'smeregister.com', 'infoquest.co.th', 'checkraka.com', 'creden.co',
  // Job boards
  'jobthai.com', 'jobsdb.com', 'jobbkk.com', 'indeed.com', 'linkedin.com',
  'thaijobsgov.com', 'nationejobs.com', 'jobth.com',
  // Social & general
  'facebook.com', 'google.com', 'wikipedia.org',
  'pantip.com', 'sanook.com', 'kapook.com',
  'sentry.io', 'wixpress.com', 'placeholder.com', 'example.com',
  // Banks
  'kasikornbank.com', 'kbank.com', 'scb.co.th', 'bangkokbank.com',
  'ktb.co.th', 'krungsri.com', 'tmb.co.th', 'ttbbank.com',
  'gsb.or.th', 'baac.or.th', 'ghbank.co.th', 'tisco.co.th',
  'lhbank.co.th', 'cimbthai.com', 'uob.co.th', 'thanachartbank.co.th',
  // Big retail / corporate
  'siammakro.co.th', 'makro.co.th', 'cpall.co.th', '7eleven.co.th',
  'bigc.co.th', 'lotuss.com', 'central.co.th', 'homepro.co.th',
  'doikham.co.th', 'teleinfomedia.co.th',
  // Unrelated companies found in test
  'tencent.co.th', 'roblox.com', 'sermsukplc.com', 'thespinoff.co.nz',
  'kex-express.com', 'autohome.com.cn', 'btnet.com.tw', 'aui.ma',
  'record-a.autohome.com.cn', 'ponpe.com', 'smjip.com',
  'atta.or.th', 'warin.co.th', 'menatransport.co.th',
  'btacia.co.th', 'uaeconsultant.com', 'zainoifb.com',
  'ideal1world.com', '168studioandsupply.com', 'ie.co.th',
  'asianet.co.th', 'sgb.co.th',
  // Chinese / foreign junk domains
  'zhihu.com', 'pizzaexpress.cn',
  // Thai platforms / unrelated from round 4
  'renthub.in.th', 'hrcenter.co.th', 'sritranggroup.com',
  'amjakastudio.co.th', 'hinothailand.com', 'optasiacapital.com',
  'smooth-e.com', 'reddoorsamsen.com', 'accellence.co.th',
  'mission-t.co.th', 'vichai.group', 'degree.plus',
  'baanpattayagroup.com', 'idinarchitects.com',
  'worldpump-wpm.com', 'jwtech.co.th', 'xplus.co.th',
  // Big Thai corporates from round 5
  'centralpattana.co.th', 'scg.com', 'scgchemicals.com',
  'ttwplc.com', 'oic.or.th', 'sam.or.th', 'thnic.co.th',
  'lmwn.com', 'systems.co.th',
  // Foreign unrelated from round 5
  'ahlsell.se', 'startuptalky.com', 'dezpax.com',
  'pronalityacademy.com', 'thaiinternships.com',
  'lifestyletech.co.th', 'jorakay.co.th', 'prompt1992.com',
  'gfreight.co.th', 'qbic.co.th', 'yellbkk.com',
  // Hospitals / unrelated from round 6
  'thainakarin.co.th', 'bumrungrad.com', 'bdms.co.th',
  // Recruitment / HR platforms
  'trustmail.jobthai', 'getlinks.com', 'prtr.com', 'adecco.co.th',
  'manpower.co.th', 'randstad.co.th', 'roberthalf.co.th',
  // Microsoft / tech support
  'microsoft.com', 'apple.com', 'support.com',
];

// Generic email providers — these are OK for Thai SMEs
const GENERIC_PROVIDERS = [
  'gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'live.com',
  'hotmail.co.th', 'yahoo.co.th', 'icloud.com', 'me.com',
  'protonmail.com', 'mail.com', 'gmx.com',
];

// Track emails already assigned to companies (duplicate detection)
const emailAssignmentCount = {};

const ALLOWED_SHORT_LOCAL = ['info','sales','contact','sale','hr','admin','acc','fax'];

function isBlacklistedEmail(email) {
  if (!email) return true;
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split('@');
  if (!domain) return true;

  // Block ALL government emails (*.go.th)
  if (domain.endsWith('.go.th')) return true;

  // Block Chinese domains (*.cn)
  if (domain.endsWith('.cn')) return true;

  // Block other foreign TLDs unlikely for Thai SMEs
  const foreignTLDs = ['.se','.de','.fr','.ru','.kr','.jp','.tw','.br','.mx','.nz','.ma'];
  if (foreignTLDs.some(tld => domain.endsWith(tld))) return true;

  // Block university/academic emails
  if (domain.endsWith('.ac.th') || domain.endsWith('.edu')) return true;

  // Block short/junk local parts (but keep info@, sales@, contact@ etc.)
  if (localPart.length < 3 && !ALLOWED_SHORT_LOCAL.includes(localPart)) return true;

  // Block obvious junk patterns
  if (/^x{3,}$/.test(localPart)) return true;  // xxxx@
  if (/^\d{1,3}$/.test(localPart)) return true; // 25@, 1@

  return BLACKLIST_DOMAINS.some(bl => domain === bl || domain.endsWith('.' + bl));
}

function isGenericProvider(email) {
  const domain = email.toLowerCase().split('@')[1] || '';
  return GENERIC_PROVIDERS.includes(domain);
}

// ─── Company Name → English Domain Matching ─────────────────
// Common Thai→English transliterations for company name matching
const THAI_COMPANY_SUFFIXES = /บริษัท|จำกัด|มหาชน|\(ประเทศไทย\)|ห้างหุ้นส่วน|สามัญ|จำกัด\s*\(มหาชน\)/g;

function normalizeCompanyName(name) {
  return name
    .replace(THAI_COMPANY_SUFFIXES, '')
    .replace(/[\s().,\-\/&]/g, '')
    .toLowerCase();
}

// Extract possible English keywords from company name (Thai names often have English parts)
function extractEnglishParts(name) {
  const english = name.match(/[a-zA-Z]{3,}/g) || [];
  return english.map(e => e.toLowerCase());
}

// Check if email domain is plausibly related to company
function isDomainRelatedToCompany(domain, companyName) {
  const domainBase = domain.split('.')[0].toLowerCase();
  if (domainBase.length < 2) return false;

  const cleanName = normalizeCompanyName(companyName);
  const englishParts = extractEnglishParts(companyName);

  // Direct match: domain appears in company name or vice versa
  if (cleanName.includes(domainBase) || domainBase.includes(cleanName.slice(0, 4))) return true;

  // English part match: e.g. company "ไอร่า แคปปิตอล" has domain "aira.co.th"
  if (englishParts.some(ep => domainBase.includes(ep) || ep.includes(domainBase))) return true;

  // Abbreviation match: e.g. "แอดวานซ์ อินโฟร์ เซอร์วิส" → "ais"
  const initials = companyName.replace(THAI_COMPANY_SUFFIXES, '').trim().split(/\s+/).map(w => w[0] || '').join('').toLowerCase();
  if (initials.length >= 2 && domainBase.includes(initials)) return true;

  return false;
}

// Score email quality: higher = better
function scoreEmail(email, companyName) {
  if (!email) return -1;
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split('@');
  if (!domain) return -1;
  const domainBase = domain.split('.')[0];

  // Already assigned to another company → likely directory email
  const assignCount = emailAssignmentCount[lower] || 0;
  if (assignCount >= 1) return -10; // duplicate = reject

  // Blacklisted → reject
  if (isBlacklistedEmail(email)) return -10;

  // Generic provider (gmail, hotmail) → acceptable only with business-like local part
  if (isGenericProvider(email)) {
    // Prefer local parts that look business-related (contain company-related words)
    const englishParts = extractEnglishParts(companyName);
    const hasCompanyRef = englishParts.some(ep => localPart.includes(ep));
    if (hasCompanyRef) return 60; // gmail but has company name reference
    // Generic gmail without company ref = low quality
    if (['info', 'sales', 'contact', 'hr', 'admin', 'acc'].some(p => localPart.startsWith(p))) return 40;
    return 25; // random gmail — low quality
  }

  // Company-specific domain: check if related to company name
  if (isDomainRelatedToCompany(domain, companyName)) {
    // Strong match — domain belongs to the company
    if (['info', 'contact', 'sales', 'hr', 'admin', 'support'].some(p => localPart.startsWith(p))) return 120;
    return 100; // strong match
  }

  // .co.th domains — likely a real Thai company, give moderate score
  if (domain.endsWith('.co.th')) {
    // Business-like prefix = somewhat trustworthy
    if (['info', 'contact', 'sales', 'hr', 'admin', 'support', 'service'].some(p => localPart.startsWith(p))) return 35;
    return 25; // .co.th but can't verify match — still above threshold
  }

  // .com domains without match — could be any company
  if (domain.endsWith('.com')) {
    if (['info', 'contact', 'sales', 'hr', 'admin'].some(p => localPart.startsWith(p))) return 25;
    return 15; // low confidence
  }

  return 20; // unknown TLD, low confidence
}

function filterValidEmails(emails, companyName) {
  if (!emails) return { best: null, all: [], confidence: 'none' };
  const list = Array.isArray(emails) ? emails : [emails];

  // Minimum score threshold — reject emails that are likely wrong company
  const MIN_SCORE = 20;

  // Score and sort
  const scored = list
    .filter(e => e && typeof e === 'string')
    .map(e => ({ email: e, score: scoreEmail(e, companyName) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { best: null, all: [], confidence: 'none' };

  const best = scored[0].email;
  const confidence = scored[0].score >= 100 ? 'high' : scored[0].score >= 50 ? 'medium' : 'low';

  // Track assignment
  emailAssignmentCount[best.toLowerCase()] = (emailAssignmentCount[best.toLowerCase()] || 0) + 1;

  return {
    best: best,
    all: scored.map(x => x.email),
    confidence: confidence,
  };
}

// Save result for a company
app.post('/api/companies/:id/result', (req, res) => {
  try {
    const { id } = req.params;
    let { email, all_emails, source_url, status, source, error_message } = req.body;

    const company = db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
    if (!company) {
      return res.status(404).json({ error: 'Company not found' });
    }

    // Filter out blacklisted/duplicate/irrelevant emails
    const filtered = filterValidEmails(all_emails || (email ? [email] : []), company.company_name);
    email = filtered.best;
    all_emails = filtered.all;
    const confidence = filtered.confidence;

    // If email was "found" but all emails were filtered out, mark as not_found
    if (status === 'found' && !email) {
      status = 'not_found';
      log(`Filtered out bad email for "${company.company_name}" (blacklisted/duplicate/irrelevant)`);
    } else if (email && confidence === 'low') {
      log(`Low confidence email for "${company.company_name}": ${email}`);
    }

    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
    const today = todayStr();
    ensureDailyStats(today);

    // Determine final status
    let finalStatus = status;
    if (status === 'error' && (company.retry_count || 0) < 3) {
      finalStatus = 'retry';
    }

    // Serialize all_emails if it's an array
    const allEmailsStr = Array.isArray(all_emails) ? all_emails.join(', ') : (all_emails || null);

    // Update company
    db.prepare(`
      UPDATE companies SET
        email = COALESCE(?, email),
        all_emails = COALESCE(?, all_emails),
        source_url = COALESCE(?, source_url),
        status = ?,
        error_message = ?,
        retry_count = CASE WHEN ? = 'error' THEN retry_count + 1 ELSE retry_count END,
        processed_date = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      email || null,
      allEmailsStr,
      source_url || null,
      finalStatus,
      error_message || null,
      status, // original status for retry check
      now,
      now,
      id
    );

    // Update daily_stats — use finalStatus (after retry logic) and check actual email
    const hasEmail = !!(email && email.trim());
    if (finalStatus === 'done' || finalStatus === 'found') {
      if (hasEmail) {
        db.prepare('UPDATE daily_stats SET processed = processed + 1, found = found + 1 WHERE date = ?').run(today);
        sessionFound++;
      } else {
        db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
      }
    } else if (finalStatus === 'not_found') {
      db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
    } else if (finalStatus === 'error') {
      db.prepare('UPDATE daily_stats SET processed = processed + 1, errors = errors + 1 WHERE date = ?').run(today);
    } else if (finalStatus === 'retry') {
      // retry = will be reprocessed, don't count as processed yet
    } else {
      db.prepare('UPDATE daily_stats SET processed = processed + 1 WHERE date = ?').run(today);
    }

    // Track in error buffer for anti-blocking
    trackResult(status === 'error');

    // Track speed and session count (exclude retry — will be reprocessed)
    recentSpeeds.push(Date.now());
    if (recentSpeeds.length > 10) recentSpeeds.shift();

    if (finalStatus !== 'retry') {
      sessionProcessed++;
    }

    const stats = getDailyStats(today);
    res.json({
      success: true,
      final_status: finalStatus,
      stats: {
        processed_today: stats.processed,
        found_today: stats.found,
      },
    });
  } catch (err) {
    log(`ERROR /api/companies/:id/result: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Manual Session Control + Built-in Worker ───────────────

let workerRunning = false;
let workerTimer = null;

// Search SearXNG directly from API
function searchSearXNG(query, engines) {
  return new Promise((resolve, reject) => {
    const url = `http://emailhunter-searxng:8080/search?q=${encodeURIComponent(query)}&format=json&engines=${engines}`;
    http.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
  });
}

// Extract emails from search results
function extractEmails(results) {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emails = new Set();
  for (const r of (results || [])) {
    const text = [r.title, r.content, r.url].filter(Boolean).join(' ');
    const found = text.match(emailRegex) || [];
    found.forEach(e => emails.add(e.toLowerCase()));
  }
  return [...emails];
}

// Process one company
async function processOneCompany() {
  if (manualMode !== 'running' || !workerRunning) return false;

  const company = db.prepare(
    `SELECT id, company_name FROM companies WHERE status IN ('pending','retry') ORDER BY CASE WHEN status='retry' THEN 0 ELSE 1 END, id ASC LIMIT 1`
  ).get();

  if (!company) {
    log('Worker: no pending companies');
    return false;
  }

  try {
    const query = buildQuery(company.company_name);
    const engines = pickEngine();
    log(`Worker: searching "${company.company_name}" [${engines}]`);

    const searchResult = await searchSearXNG(query, engines);
    const allEmails = extractEmails(searchResult.results || []);
    const filtered = filterValidEmails(allEmails, company.company_name);

    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
    const today = todayStr();
    ensureDailyStats(today);

    let status, email;
    if (filtered.best) {
      status = 'found';
      email = filtered.best;
      sessionFound++;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, found = found + 1 WHERE date = ?').run(today);
    } else {
      status = 'not_found';
      email = null;
      db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
    }

    const allEmailsStr = filtered.all.join(', ') || null;
    db.prepare(`UPDATE companies SET email=?, all_emails=?, status=?, processed_date=?, updated_at=? WHERE id=?`)
      .run(email, allEmailsStr, status, now, now, company.id);

    sessionProcessed++;
    recentSpeeds.push(Date.now());
    if (recentSpeeds.length > 20) recentSpeeds.shift();
    trackResult(false);

    log(`Worker: ${company.company_name} → ${status}${email ? ' (' + email + ')' : ''}`);
    return true;
  } catch (err) {
    log(`Worker ERROR: ${company.company_name} — ${err.message}`);
    trackResult(true);
    const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
    db.prepare(`UPDATE companies SET status='retry', error_message=?, retry_count=retry_count+1, updated_at=? WHERE id=?`)
      .run(err.message, now, company.id);
    sessionProcessed++;
    return true;
  }
}

// Worker loop — with Work Cycle system
async function workerLoop() {
  if (!workerRunning || manualMode !== 'running') {
    workerRunning = false;
    log('Worker stopped');
    return;
  }

  // เช็ค daily limit (สุ่ม)
  const dailyLimit = getDailyLimit();
  const processedToday = getProcessedToday();
  if (processedToday >= dailyLimit) {
    log(`Daily limit reached (${processedToday}/${dailyLimit}) — entering long rest`);
    startLongRest();

    // Lark: แจ้งครบ limit
    const stats = getDailyStats(todayStr());
    notifyLark('Daily Limit Reached', [
      `**ครบ ${formatNumber(processedToday)} / ${formatNumber(dailyLimit)} วันนี้**`,
      `Emails: ${formatNumber(stats.found || 0)} | Not Found: ${formatNumber(stats.not_found || 0)}`,
      `Cycle: รอบที่ ${workCycle.cycleCount}`,
      `พักยาว ${Math.round(workCycle.restDuration / 60000)} นาที แล้วเริ่มวันใหม่`,
    ].join('\n'), 'blue');

    // Log session
    if (sessionStartTime && sessionProcessed > 0) {
      db.prepare(`INSERT INTO session_log (start_time, end_time, processed, found, not_found, errors, blocks_detected) VALUES (?,?,?,?,?,?,?)`)
        .run(sessionStartTime, nowTimeStr(), sessionProcessed, sessionFound, sessionProcessed - sessionFound, 0, sessionBlocksDetected);
      sessionStartTime = null; sessionProcessed = 0; sessionFound = 0; sessionBlocksDetected = 0;
    }

    // รอพักยาวแล้ว restart
    workerTimer = setTimeout(() => {
      log('Long rest complete — resuming');
      startWorkPhase();
      notifyLark('กลับมาทำงาน (วันใหม่)', `**Work Phase ${workCycle.cycleCount}** — ${Math.round(workCycle.workDuration / 60000)} นาที`, 'green');
      workerLoop();
    }, workCycle.restDuration);
    return;
  }

  // เช็ค Work Cycle — ถึงเวลาพักหรือยัง
  if (workCycle.phase === 'idle') {
    startWorkPhase();
    notifyLark('เริ่มทำงาน', [
      `**Work Phase ${workCycle.cycleCount}** — ${Math.round(workCycle.workDuration / 60000)} นาที`,
      `Daily Limit: ${formatNumber(dailyLimit)} | Pending: ${formatNumber(db.prepare("SELECT COUNT(*) as c FROM companies WHERE status IN ('pending','retry')").get().c)}`,
    ].join('\n'), 'green');
  }

  const cycleCheck = checkWorkCycle();
  if (cycleCheck.shouldRest) {
    // จบ Work Phase → เข้า Rest Phase
    startRestPhase();

    const stats = getDailyStats(todayStr());
    notifyLark(`พักรอบที่ ${workCycle.cycleCount}`, [
      `**ทำไป ${formatNumber(workCycle.queriesThisPhase)} ราย** รอบนี้`,
      `วันนี้: ${formatNumber(processedToday)} / ${formatNumber(dailyLimit)}`,
      `Emails: ${formatNumber(stats.found || 0)} (${stats.processed > 0 ? ((stats.found / stats.processed) * 100).toFixed(1) : 0}%)`,
      `พัก ${Math.round(workCycle.restDuration / 60000)} นาที`,
    ].join('\n'), 'yellow');

    workerTimer = setTimeout(() => {
      if (!workerRunning || manualMode !== 'running') { workerRunning = false; return; }
      startWorkPhase();
      notifyLark(`กลับมาทำงาน — รอบ ${workCycle.cycleCount}`, [
        `**Work Phase ${workCycle.cycleCount}** — ${Math.round(workCycle.workDuration / 60000)} นาที`,
        `เหลือวันนี้: ${formatNumber(dailyLimit - processedToday)}`,
      ].join('\n'), 'green');
      workerLoop();
    }, workCycle.restDuration);
    return;
  }

  // ทำงานจริง
  const hasMore = await processOneCompany();
  workCycle.queriesThisPhase++;
  workCycle.totalQueriesToday++;

  if (!hasMore) {
    workerRunning = false;
    manualMode = null;
    workCycle.phase = 'idle';
    log('Worker finished — no more pending');
    notifyLark('งานเสร็จ — ไม่มี Pending', [
      `**ประมวลผลครบ!**`,
      `วันนี้: ${formatNumber(processedToday)} | Emails: ${formatNumber(sessionFound)}`,
      `กรุณา upload บริษัทชุดใหม่`,
    ].join('\n'), 'blue');
    return;
  }

  // Adaptive delay + slow start + coffee break + error spike
  let delay = getAdaptiveDelay();
  delay *= getSlowStartMultiplier();
  const breakCheck = checkSessionBreak();
  const errorCheck = checkErrorSpike();

  if (errorCheck.shouldPause) {
    sessionBlocksDetected++;
    ensureDailyStats(todayStr());
    db.prepare('UPDATE daily_stats SET blocks_detected = blocks_detected + 1 WHERE date = ?').run(todayStr());
    const errRate = errorBuffer.length >= 5 ? Math.round(errorBuffer.filter(Boolean).length / errorBuffer.length * 100) : 0;
    notifyLark('Error Rate สูง', [
      `**Error rate: ${errRate}%** — หยุดพัก ${Math.round(errorCheck.pauseDuration / 60)} นาที`,
      `Adaptive delay: ${adaptiveDelayMean}s (ปรับขึ้นอัตโนมัติ)`,
    ].join('\n'), 'red');
  }

  if (breakCheck.shouldPause || errorCheck.shouldPause) {
    const pauseMs = Math.max(breakCheck.pauseDuration, errorCheck.pauseDuration) * 1000;
    log(`Worker: pause ${Math.round(pauseMs / 1000)}s (coffee=${breakCheck.shouldPause}, error=${errorCheck.shouldPause})`);
    workerTimer = setTimeout(workerLoop, pauseMs);
  } else {
    workerTimer = setTimeout(workerLoop, delay * 1000);
  }
}

// Start session — เริ่มทำงานทันที
app.post('/api/session/start', (req, res) => {
  manualMode = 'running';
  manualModeSetAt = new Date().toISOString();
  sessionStartTime = new Date().toISOString();
  sessionProcessed = 0;
  sessionFound = 0;
  sessionBlocksDetected = 0;

  if (!workerRunning) {
    workerRunning = true;
    workCycle.phase = 'idle'; // จะเริ่ม work phase ใน workerLoop
    log(`START — worker started`);
    workerLoop();
  }

  res.json({ success: true, mode: 'running', message: 'Processing started.' });
});

// Stop session
app.post('/api/session/stop', (req, res) => {
  manualMode = 'stopped';
  manualModeSetAt = new Date().toISOString();
  workerRunning = false;
  workCycle.phase = 'idle';
  if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }

  notifyLark('หยุดทำงาน (Manual Stop)', [
    `Processed: ${formatNumber(sessionProcessed)} | Found: ${formatNumber(sessionFound)}`,
    `Cycle: รอบที่ ${workCycle.cycleCount}`,
  ].join('\n'), 'yellow');

  log(`STOP — worker stopped (processed: ${sessionProcessed}, found: ${sessionFound})`);
  res.json({ success: true, mode: 'stopped', message: `Stopped. This run: ${sessionProcessed} processed, ${sessionFound} found.` });
});

// Resume — กลับมาทำงานต่อ
app.post('/api/session/auto', (req, res) => {
  manualMode = null;
  manualModeSetAt = null;
  workerRunning = false;
  workCycle.phase = 'idle';
  if (workerTimer) { clearTimeout(workerTimer); workerTimer = null; }
  log(`AUTO MODE — idle`);
  res.json({ success: true, mode: 'auto', message: 'System idle. Press Start to begin.' });
});

// Get current session mode
app.get('/api/session/status', (req, res) => {
  res.json({
    mode: manualMode || 'auto',
    set_at: manualModeSetAt,
    worker_running: workerRunning,
    session_active: sessionStartTime !== null,
    session_start: sessionStartTime,
    processed_today: getProcessedToday(),
    daily_limit: getDailyLimit(),
    work_cycle: {
      phase: workCycle.phase,
      cycle_count: workCycle.cycleCount,
      queries_this_phase: workCycle.queriesThisPhase,
      rest_remaining_ms: getRestRemaining(),
      phase_start: workCycle.phaseStart ? new Date(workCycle.phaseStart).toISOString() : null,
    },
  });
});

// Full stats for dashboard
app.get('/api/stats', (req, res) => {
  try {
    const today = todayStr();
    ensureDailyStats(today);

    // Overall counts
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    const found = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found') AND email IS NOT NULL AND email != ''").get().cnt;
    const notFound = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'not_found'").get().cnt;
    const errors = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'error'").get().cnt;
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('pending','retry')").get().cnt;
    // PROCESSED = all companies that finished processing (found + not_found + errors)
    const processed = found + notFound + errors;

    const successRate = processed > 0 ? Math.round((found / processed) * 1000) / 10 : 0;

    // Today stats
    const todayStats = getDailyStats(today);

    // Speed calculations
    let currentSpeed = 0;
    if (recentSpeeds.length >= 2) {
      const elapsed = (recentSpeeds[recentSpeeds.length - 1] - recentSpeeds[0]) / 1000 / 60; // minutes
      currentSpeed = elapsed > 0 ? Math.round((recentSpeeds.length / elapsed) * 10) / 10 : 0;
    }

    let avgSpeed = 0;
    if (sessionStartTime && sessionProcessed > 0) {
      const sessionMinutes = (Date.now() - new Date(sessionStartTime).getTime()) / 1000 / 60;
      avgSpeed = sessionMinutes > 0 ? Math.round((sessionProcessed / sessionMinutes) * 10) / 10 : 0;
    }

    // Daily history (last 30 days)
    const dailyHistory = db.prepare(
      'SELECT date, processed, found, not_found, errors, blocks_detected FROM daily_stats ORDER BY date DESC LIMIT 30'
    ).all();

    // Recent results (all from today)
    const recent = db.prepare(`
      SELECT company_name as company, email, status,
             substr(updated_at, 12, 8) as time
      FROM companies
      WHERE processed_date LIKE ? AND status IN ('done','found','not_found')
      ORDER BY updated_at DESC
    `).all(`${today}%`);

    // Error log (last 50 errors from today)
    const errorLog = db.prepare(`
      SELECT company_name as company, error_message as error,
             substr(updated_at, 12, 8) as time
      FROM companies
      WHERE processed_date LIKE ? AND status IN ('error','retry')
      ORDER BY updated_at DESC LIMIT 50
    `).all(`${today}%`);

    // Determine system status
    let systemStatus = 'idle';
    if (workerRunning) {
      systemStatus = 'running';
    } else if (sessionStartTime) {
      const lastActivity = recentSpeeds.length > 0 ? recentSpeeds[recentSpeeds.length - 1] : 0;
      const sinceLastActivity = lastActivity > 0 ? (Date.now() - lastActivity) / 1000 : Infinity;
      if (sinceLastActivity < 120) {
        systemStatus = 'running';
      } else if (sinceLastActivity < 600) {
        systemStatus = 'paused';
      }
    }

    // Speed trend (compare first half vs second half of recentSpeeds)
    let speedTrend = 'stable';
    if (recentSpeeds.length >= 6) {
      const mid = Math.floor(recentSpeeds.length / 2);
      const firstHalf = (recentSpeeds[mid] - recentSpeeds[0]) / mid;
      const secondHalf = (recentSpeeds[recentSpeeds.length - 1] - recentSpeeds[mid]) / (recentSpeeds.length - mid);
      if (secondHalf < firstHalf * 0.8) speedTrend = 'increasing'; // faster = less time between
      else if (secondHalf > firstHalf * 1.2) speedTrend = 'decreasing'; // slower = more time between
    }

    // Anti-block info
    const errorRate = errorBuffer.length >= 5 ? errorBuffer.filter(Boolean).length / errorBuffer.length : 0;
    let abStatus = 'normal';
    if (errorRate > 0.5) abStatus = 'paused';
    else if (errorRate > 0.3) abStatus = 'throttled';

    // Last updated from most recent activity
    const lastUpdatedTs = recentSpeeds.length > 0 ? new Date(recentSpeeds[recentSpeeds.length - 1]).toISOString() : null;

    res.json({
      total_companies: total,
      processed,
      found,
      not_found: notFound,
      errors,
      pending,
      success_rate: successRate,
      // Root-level fields for dashboard
      current_speed: currentSpeed,
      avg_speed: avgSpeed,
      speed_trend: speedTrend,
      status: systemStatus,
      last_updated: lastUpdatedTs,
      anti_block: {
        status: abStatus,
        blocks_today: sessionBlocksDetected,
        queries_until_break: nextBreakAt - queriesSinceBreak,
        error_rate: Math.round(errorRate * 100),
      },
      session: {
        active: sessionStartTime !== null,
        start_time: sessionStartTime || '',
        companies_this_session: sessionProcessed,
        found_this_session: sessionFound,
        blocks_detected: sessionBlocksDetected,
        current_speed: currentSpeed,
        avg_speed: avgSpeed,
        queries_until_break: nextBreakAt - queriesSinceBreak,
      },
      today: {
        date: today,
        processed: todayStats.processed,
        found: todayStats.found,
        not_found: todayStats.not_found,
        errors: todayStats.errors || 0,
        blocks_detected: todayStats.blocks_detected || 0,
      },
      work_cycle: {
        phase: workCycle.phase,
        cycle_count: workCycle.cycleCount,
        queries_this_phase: workCycle.queriesThisPhase,
        work_duration_min: Math.round((workCycle.workDuration || 0) / 60000),
        rest_duration_min: Math.round((workCycle.restDuration || 0) / 60000),
        phase_elapsed_min: workCycle.phaseStart ? Math.round((Date.now() - workCycle.phaseStart) / 60000) : 0,
        rest_remaining_min: Math.round(getRestRemaining() / 60000),
        adaptive_delay: adaptiveDelayMean,
      },
      daily_limit: getDailyLimit(),
      daily_history: dailyHistory,
      recent,
      error_log: errorLog,
      manual_mode: manualMode || 'auto',
    });
  } catch (err) {
    log(`ERROR /api/stats: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Reset all data for fresh start
app.post('/api/reset', (req, res) => {
  try {
    db.prepare('DELETE FROM companies').run();
    db.prepare('DELETE FROM daily_stats').run();
    db.prepare('DELETE FROM session_log').run();

    // Reset in-memory session tracking
    sessionStartTime = null;
    sessionProcessed = 0;
    sessionFound = 0;
    sessionBlocksDetected = 0;
    recentSpeeds.length = 0;
    errorBuffer.length = 0;
    lastEngines.length = 0;
    queriesSinceBreak = 0;
    nextBreakAt = randomBetween(30, 60);
    Object.keys(emailAssignmentCount).forEach(k => delete emailAssignmentCount[k]);

    log('ALL DATA RESET — companies, daily_stats, session_log cleared');
    res.json({ success: true, message: 'All data has been reset' });
  } catch (err) {
    log(`ERROR /api/reset: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Excel import
app.post('/api/import', upload.single('file'), (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    filePath = req.file.path;

    log(`Importing file: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) {
      return res.status(400).json({ error: 'Empty spreadsheet' });
    }

    // Auto-detect columns
    const headers = Object.keys(rows[0]);
    let companyCol = headers.find(h => /company|บริษัท|ชื่อ|name/i.test(h));
    const taxIdCol = headers.find(h => /tax_id|เลขที่|tax|เลขประจำตัว/i.test(h));
    const industryCol = headers.find(h => /industry|ประเภท|อุตสาหกรรม/i.test(h));

    // Fallback: if single column and no header detected, treat as headerless file
    // Re-read with header option to include first row as data
    if (!companyCol && headers.length === 1) {
      log('No header detected, single column — treating as headerless company list');
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      rows.length = 0;
      for (const r of rawRows) {
        const val = String(r[0] || '').trim();
        if (val) rows.push({ company_name: val });
      }
      companyCol = 'company_name';
    } else if (!companyCol && headers.length > 1) {
      // Multiple columns but no match — use first column as company name
      log(`No header match found, using first column "${headers[0]}" as company name`);
      companyCol = headers[0];
    }

    if (!companyCol) {
      return res.status(400).json({
        error: 'Cannot detect company name column',
        headers,
        hint: 'Column header should contain: company, บริษัท, ชื่อ, or name',
      });
    }

    log(`Detected columns — company: "${companyCol}", tax_id: "${taxIdCol || 'N/A'}", industry: "${industryCol || 'N/A'}"`);

    // Prepare insert statement
    const insert = db.prepare(`
      INSERT OR IGNORE INTO companies (company_name, tax_id, industry)
      VALUES (?, ?, ?)
    `);

    // Process in chunks of 1000
    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    const CHUNK_SIZE = 1000;

    const insertChunk = db.transaction((chunk) => {
      for (const row of chunk) {
        const name = String(row[companyCol] || '').trim();
        if (!name) {
          errors++;
          continue;
        }
        const taxId = taxIdCol ? String(row[taxIdCol] || '').trim() : null;
        const industry = industryCol ? String(row[industryCol] || '').trim() : null;

        const result = insert.run(name, taxId, industry);
        if (result.changes > 0) {
          imported++;
        } else {
          duplicates++;
        }
      }
    });

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      const chunk = rows.slice(i, i + CHUNK_SIZE);
      insertChunk(chunk);
      if (i % 10000 === 0 && i > 0) {
        log(`Import progress: ${i}/${rows.length}`);
      }
    }

    log(`Import complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);

    // Clean up
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

    res.json({
      success: true,
      imported,
      duplicates,
      total: rows.length,
      errors,
      detected_columns: {
        company: companyCol,
        tax_id: taxIdCol || null,
        industry: industryCol || null,
      },
    });
  } catch (err) {
    log(`ERROR /api/import: ${err.message}`);
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// Export results
app.get('/api/export', (req, res) => {
  try {
    const format = req.query.format || 'csv';

    const rows = db.prepare(`
      SELECT company_name, email, all_emails, source_url, status, processed_date
      FROM companies
      WHERE status IN ('done', 'found', 'not_found')
      ORDER BY processed_date DESC
    `).all();

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="emailhunter_export_${todayStr()}.json"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json(rows);
    }

    // CSV with BOM for Thai support in Excel
    const BOM = '\uFEFF';
    const header = 'company_name,email,all_emails,source_url,status,processed_date';
    const csvRows = rows.map(r => {
      return [
        csvEscape(r.company_name),
        csvEscape(r.email),
        csvEscape(r.all_emails),
        csvEscape(r.source_url),
        csvEscape(r.status),
        csvEscape(r.processed_date),
      ].join(',');
    });

    const csv = BOM + header + '\n' + csvRows.join('\n');

    res.setHeader('Content-Disposition', `attachment; filename="emailhunter_export_${todayStr()}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(csv);
  } catch (err) {
    log(`ERROR /api/export: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// Generate LINE Notify report
function generateReport() {
  const today = todayStr();
  const stats = getDailyStats(today);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
  const allProcessed = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found','not_found','error')").get().cnt;

  const processedToday = stats.processed || 0;
  const foundToday = stats.found || 0;
  const notFoundToday = stats.not_found || 0;
  const errorsToday = stats.errors || 0;
  const blocksToday = stats.blocks_detected || 0;

  const foundPct = processedToday > 0 ? ((foundToday / processedToday) * 100).toFixed(1) : '0.0';
  const notFoundPct = processedToday > 0 ? ((notFoundToday / processedToday) * 100).toFixed(1) : '0.0';
  const errorPct = processedToday > 0 ? ((errorsToday / processedToday) * 100).toFixed(1) : '0.0';

  const progressPct = total > 0 ? ((allProcessed / total) * 100).toFixed(1) : '0.0';
  const remaining = total - allProcessed;
  const etaDays = processedToday > 0 ? Math.ceil(remaining / processedToday) : '???';

  let currentSpeed = 0;
  if (recentSpeeds.length >= 2) {
    const elapsed = (recentSpeeds[recentSpeeds.length - 1] - recentSpeeds[0]) / 1000 / 60;
    currentSpeed = elapsed > 0 ? (recentSpeeds.length / elapsed).toFixed(1) : '0.0';
  }

  // Top 5 emails today
  const topEmails = db.prepare(`
    SELECT email FROM companies
    WHERE processed_date LIKE ? AND status IN ('done','found') AND email IS NOT NULL AND email != ''
    ORDER BY updated_at DESC LIMIT 5
  `).all(`${today}%`);

  const topEmailsList = topEmails.map(e => `• ${e.email}`).join('\n') || '• (ยังไม่มี)';

  const fmt = (n) => Number(n).toLocaleString();

  const report = `\n📊 EmailHunter — รายงานประจำวัน
📅 วันที่: ${today}
⏰ Work Cycles: ${workCycle.cycleCount} รอบ
─────────────────
✅ ประมวลผล: ${fmt(processedToday)}
📧 เจอ email: ${fmt(foundToday)} (${foundPct}%)
❌ ไม่เจอ: ${fmt(notFoundToday)} (${notFoundPct}%)
⚠️ Error: ${fmt(errorsToday)} (${errorPct}%)
─────────────────
📈 ความคืบหน้า: ${fmt(allProcessed)} / ${fmt(total)} (${progressPct}%)
📅 ETA: ~${etaDays} วัน
⚡ Speed: ${currentSpeed}/min
🛡️ Blocks: ${blocksToday} (auto-paused)
─────────────────
Top 5 emails วันนี้:
${topEmailsList}`;

  return report;
}

// ─── Lark API Notification ──────────────────────────────────
let larkTokenCache = { token: null, expiresAt: 0 };

function getLarkToken() {
  return new Promise((resolve, reject) => {
    const appId = process.env.LARK_APP_ID;
    const appSecret = process.env.LARK_APP_SECRET;
    if (!appId || !appSecret) return reject(new Error('LARK_APP_ID/SECRET not set'));

    // ใช้ cache ถ้ายังไม่หมดอายุ
    if (larkTokenCache.token && Date.now() < larkTokenCache.expiresAt) {
      return resolve(larkTokenCache.token);
    }

    const postData = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const options = {
      hostname: 'open.larksuite.com',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.tenant_access_token) {
            larkTokenCache = { token: json.tenant_access_token, expiresAt: Date.now() + (json.expire - 300) * 1000 };
            resolve(json.tenant_access_token);
          } else {
            reject(new Error(`Lark token error: ${data}`));
          }
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendLarkCard(title, contentMd, color = 'green') {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getLarkToken();
      const chatId = process.env.LARK_CHAT_ID;
      if (!chatId) return reject(new Error('LARK_CHAT_ID not set'));

      const colorMap = { green: 'green', red: 'red', yellow: 'yellow', blue: 'blue' };
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: colorMap[color] || 'blue',
        },
        elements: [
          { tag: 'markdown', content: contentMd },
          { tag: 'note', elements: [{ tag: 'plain_text', content: `EmailHunter | ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}` }] },
        ],
      };

      const postData = JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      });

      const options = {
        hostname: 'open.larksuite.com',
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve({ success: true });
          } else {
            log(`Lark API error ${res.statusCode}: ${data}`);
            reject(new Error(`Lark ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    } catch(e) { reject(e); }
  });
}

// Helper: ส่ง Lark แบบ fire-and-forget (ไม่ block flow หลัก)
function notifyLark(title, contentMd, color = 'green') {
  sendLarkCard(title, contentMd, color).catch(err => {
    log(`Lark notify failed: ${err.message}`);
  });
}

function sendLineNotify(message) {
  return new Promise((resolve, reject) => {
    const token = process.env.LINE_NOTIFY_TOKEN;
    if (!token) {
      return reject(new Error('LINE_NOTIFY_TOKEN not set'));
    }

    const postData = `message=${encodeURIComponent(message)}`;

    const options = {
      hostname: 'notify-api.line.me',
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve({ success: true });
        } else {
          reject(new Error(`LINE API returned ${res.statusCode}: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// Send report endpoint
app.post('/api/report/send', async (req, res) => {
  try {
    const report = generateReport();
    await sendLineNotify(report);
    log('LINE report sent successfully');
    res.json({ success: true });
  } catch (err) {
    log(`ERROR sending LINE report: ${err.message}`);
    res.json({ success: false, error: err.message });
  }
});

// Schedule check — called by n8n
app.post('/api/report/schedule-check', async (req, res) => {
  try {
    const hour = parseInt(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }),
      10
    );

    if (hour >= 9) {
      log('Schedule check: time to stop and send report');
      let reportSent = false;
      try {
        const report = generateReport();
        await sendLineNotify(report);
        reportSent = true;
        log('Daily report sent via schedule-check');
      } catch (err) {
        log(`Failed to send report: ${err.message}`);
      }

      // Log session
      if (sessionStartTime) {
        db.prepare(`
          INSERT INTO session_log (start_time, end_time, processed, found, not_found, errors, blocks_detected)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          sessionStartTime,
          nowTimeStr(),
          sessionProcessed,
          sessionFound,
          sessionProcessed - sessionFound, // approximate
          0,
          sessionBlocksDetected
        );
        // Reset session
        sessionStartTime = null;
        sessionProcessed = 0;
        sessionFound = 0;
        sessionBlocksDetected = 0;
      }

      return res.json({ should_stop: true, report_sent: reportSent });
    }

    res.json({ should_stop: false });
  } catch (err) {
    log(`ERROR /api/report/schedule-check: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Global error handler ────────────────────────────────────
app.use((err, req, res, next) => {
  log(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start server ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  log(`EmailHunter API v3.0.0 running on port ${PORT}`);
  log(`Database: /data/emailhunter.db`);
  log(`Mode: Work Cycle (45-65 min work / 15-30 min rest)`);
  log(`Daily limit: ${getDailyLimit()} queries (randomized 4000-4800)`);
  log(`Lark: ${process.env.LARK_APP_ID ? 'configured' : 'not configured'}`);
});

// ─── CSV Restore (import results back from exported CSV) ─────
app.post('/api/restore', upload.single('file'), (req, res) => {
  let filePath = null;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    filePath = req.file.path;

    log(`Restoring from file: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

    const content = fs.readFileSync(filePath, 'utf-8');
    // Remove BOM if present
    const clean = content.replace(/^\uFEFF/, '');
    const lines = clean.split('\n').filter(l => l.trim());

    if (lines.length < 2) {
      return res.status(400).json({ error: 'Empty CSV file' });
    }

    // Parse header
    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const companyIdx = header.indexOf('company_name');
    const emailIdx = header.indexOf('email');
    const allEmailsIdx = header.indexOf('all_emails');
    const sourceUrlIdx = header.indexOf('source_url');
    const statusIdx = header.indexOf('status');
    const dateIdx = header.indexOf('processed_date');

    if (companyIdx === -1) {
      return res.status(400).json({ error: 'Missing company_name column' });
    }

    // Parse CSV rows (handle quoted fields)
    function parseCSVLine(line) {
      const fields = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = !inQuotes;
          }
        } else if (ch === ',' && !inQuotes) {
          fields.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      fields.push(current);
      return fields;
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO companies (company_name, email, all_emails, source_url, status, processed_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
    `);

    let imported = 0;
    let duplicates = 0;
    let errors = 0;
    const CHUNK_SIZE = 500;

    const insertChunk = db.transaction((chunk) => {
      for (const fields of chunk) {
        try {
          const name = (fields[companyIdx] || '').trim();
          if (!name) { errors++; continue; }

          const email = emailIdx >= 0 ? (fields[emailIdx] || '').trim() || null : null;
          const allEmails = allEmailsIdx >= 0 ? (fields[allEmailsIdx] || '').trim() || null : null;
          const sourceUrl = sourceUrlIdx >= 0 ? (fields[sourceUrlIdx] || '').trim() || null : null;
          const status = statusIdx >= 0 ? (fields[statusIdx] || '').trim() || 'pending' : 'pending';
          const date = dateIdx >= 0 ? (fields[dateIdx] || '').trim() || null : null;

          const result = insert.run(name, email, allEmails, sourceUrl, status, date);
          if (result.changes > 0) {
            imported++;
          } else {
            duplicates++;
          }
        } catch (e) {
          errors++;
        }
      }
    });

    const dataRows = [];
    for (let i = 1; i < lines.length; i++) {
      dataRows.push(parseCSVLine(lines[i]));
    }

    for (let i = 0; i < dataRows.length; i += CHUNK_SIZE) {
      insertChunk(dataRows.slice(i, i + CHUNK_SIZE));
      if (i % 2000 === 0 && i > 0) {
        log(`Restore progress: ${i}/${dataRows.length}`);
      }
    }

    log(`Restore complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);

    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

    res.json({
      success: true,
      imported,
      duplicates,
      errors,
      total: dataRows.length,
    });
  } catch (err) {
    log(`ERROR /api/restore: ${err.message}`);
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto-Backup System ─────────────────────────────────────
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

function performBackup() {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    if (total === 0) {
      log('Backup skipped — database is empty');
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `emailhunter_${timestamp}.db`);

    // Use SQLite backup API
    db.backup(backupPath).then(() => {
      log(`Backup created: ${backupPath} (${total} companies)`);

      // Keep only last 7 backups
      const backups = fs.readdirSync(BACKUP_DIR)
        .filter(f => f.startsWith('emailhunter_') && f.endsWith('.db'))
        .sort()
        .reverse();

      for (let i = 7; i < backups.length; i++) {
        fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
        log(`Deleted old backup: ${backups[i]}`);
      }
    }).catch(err => {
      log(`Backup FAILED: ${err.message}`);
    });
  } catch (err) {
    log(`Backup error: ${err.message}`);
  }
}

// Backup every 6 hours
const BACKUP_INTERVAL = 6 * 60 * 60 * 1000;
setInterval(performBackup, BACKUP_INTERVAL);
// Also backup 5 seconds after startup
setTimeout(performBackup, 5000);

// Manual backup endpoint
app.post('/api/backup', (req, res) => {
  try {
    performBackup();
    res.json({ success: true, message: 'Backup initiated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List backups
app.get('/api/backups', (req, res) => {
  try {
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('emailhunter_') && f.endsWith('.db'))
      .sort()
      .reverse()
      .map(f => {
        const stat = fs.statSync(path.join(BACKUP_DIR, f));
        return { name: f, size_mb: (stat.size / 1024 / 1024).toFixed(1), date: stat.mtime.toISOString() };
      });
    res.json({ backups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore from backup
app.post('/api/backup/restore', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Backup name required' });

    const backupPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });

    // Validate the backup is a valid SQLite DB
    const testDb = new Database(backupPath, { readonly: true });
    const count = testDb.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    testDb.close();

    // Copy backup over current DB
    const dbPath = path.join(DATA_DIR, 'emailhunter.db');
    fs.copyFileSync(backupPath, dbPath);

    log(`Restored from backup: ${name} (${count} companies)`);
    res.json({ success: true, message: `Restored ${count} companies from ${name}. Restart container to apply.` });
  } catch (err) {
    log(`Restore from backup error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── CSV Auto-Export on shutdown ─────────────────────────────
function exportCSVBackup() {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    if (total === 0) return;

    const rows = db.prepare(`
      SELECT company_name, email, all_emails, source_url, status, processed_date
      FROM companies ORDER BY id
    `).all();

    const BOM = '\uFEFF';
    const header = 'company_name,email,all_emails,source_url,status,processed_date';
    const csvRows = rows.map(r => {
      return [
        csvEscape(r.company_name),
        csvEscape(r.email),
        csvEscape(r.all_emails),
        csvEscape(r.source_url),
        csvEscape(r.status),
        csvEscape(r.processed_date),
      ].join(',');
    });

    const csv = BOM + header + '\n' + csvRows.join('\n');
    const csvPath = path.join(BACKUP_DIR, `auto_export_${todayStr()}.csv`);
    fs.writeFileSync(csvPath, csv, 'utf-8');
    log(`Auto CSV export: ${csvPath} (${rows.length} rows)`);
  } catch (err) {
    log(`CSV export error: ${err.message}`);
  }
}

// Graceful shutdown — backup before exit
process.on('SIGINT', () => {
  log('Shutting down... creating backup');
  performBackup();
  exportCSVBackup();
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down... creating backup');
  performBackup();
  exportCSVBackup();
  db.close();
  process.exit(0);
});
