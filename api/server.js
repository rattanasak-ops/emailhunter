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
  CREATE INDEX IF NOT EXISTS idx_company_name ON companies(company_name);

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

// 6. Daily Limits
const DAILY_LIMIT = 4500;

// ─── Session tracking ────────────────────────────────────────
let sessionStartTime = null;
let sessionProcessed = 0;
let sessionFound = 0;
let sessionBlocksDetected = 0;
const recentSpeeds = []; // timestamps of last 10 results for speed calc

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
    const withinSchedule = isWithinSchedule();
    const forceRun = req.query.force === 'true';
    const shouldStop = (!withinSchedule && !forceRun) || processedToday >= DAILY_LIMIT;

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
      return res.json({
        company: null,
        session: { should_stop: true, reason: 'no_pending' },
      });
    }

    if (shouldStop) {
      return res.json({
        company: null,
        session: {
          should_stop: true,
          reason: processedToday >= DAILY_LIMIT ? 'daily_limit' : 'outside_schedule',
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
    const delay = gaussianDelay();
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
// Blacklisted domains: directory sites, job boards, data aggregators
const BLACKLIST_DOMAINS = [
  'connectbizs.com', 'jobthai.com', 'creden.co', 'longdo.com',
  'yellowpages.co.th', 'trustonline.co.th', 'thaidbs.com',
  'thaibizdir.com', 'registered.in.th', 'dataforthai.com',
  'smeregister.com', 'infoquest.co.th', 'checkraka.com',
  'jobsdb.com', 'jobbkk.com', 'indeed.com', 'linkedin.com',
  'facebook.com', 'google.com', 'wikipedia.org',
  'thaijobsgov.com', 'nationejobs.com', 'jobth.com',
  'pantip.com', 'sanook.com', 'kapook.com',
];

function isBlacklistedEmail(email) {
  if (!email) return true;
  const domain = email.toLowerCase().split('@')[1] || '';
  return BLACKLIST_DOMAINS.some(bl => domain === bl || domain.endsWith('.' + bl));
}

function filterValidEmails(emails, companyName) {
  if (!emails) return { best: null, all: [] };
  const list = Array.isArray(emails) ? emails : [emails];
  const clean = list.filter(e => e && !isBlacklistedEmail(e));
  if (clean.length === 0) return { best: null, all: [] };
  return { best: clean[0], all: clean };
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

    // Filter out blacklisted emails
    const filtered = filterValidEmails(all_emails || (email ? [email] : []), company.company_name);
    email = filtered.best;
    all_emails = filtered.all;

    // If email was "found" but all emails were blacklisted, mark as not_found
    if (status === 'found' && !email) {
      status = 'not_found';
      log(`Filtered out blacklisted email for "${company.company_name}"`);
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

    // Update daily_stats
    if (status === 'done' || status === 'found') {
      db.prepare('UPDATE daily_stats SET processed = processed + 1, found = found + 1 WHERE date = ?').run(today);
      sessionFound++;
    } else if (status === 'not_found') {
      db.prepare('UPDATE daily_stats SET processed = processed + 1, not_found = not_found + 1 WHERE date = ?').run(today);
    } else if (status === 'error') {
      db.prepare('UPDATE daily_stats SET processed = processed + 1, errors = errors + 1 WHERE date = ?').run(today);
    } else {
      db.prepare('UPDATE daily_stats SET processed = processed + 1 WHERE date = ?').run(today);
    }

    // Track in error buffer for anti-blocking
    trackResult(status === 'error');

    // Track speed
    recentSpeeds.push(Date.now());
    if (recentSpeeds.length > 10) recentSpeeds.shift();

    sessionProcessed++;

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

// Full stats for dashboard
app.get('/api/stats', (req, res) => {
  try {
    const today = todayStr();
    ensureDailyStats(today);

    // Overall counts
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    const processed = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found')").get().cnt;
    const found = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found') AND email IS NOT NULL AND email != ''").get().cnt;
    const notFound = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'not_found'").get().cnt;
    const errors = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'error'").get().cnt;
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('pending','retry')").get().cnt;

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
      // Rough avg: processed / minutes since session start
      const sessionMinutes = process.uptime() / 60;
      avgSpeed = sessionMinutes > 0 ? Math.round((sessionProcessed / sessionMinutes) * 10) / 10 : 0;
    }

    // Daily history (last 30 days)
    const dailyHistory = db.prepare(
      'SELECT date, processed, found, not_found, errors, blocks_detected FROM daily_stats ORDER BY date DESC LIMIT 30'
    ).all();

    // Recent results (last 50 from today)
    const recent = db.prepare(`
      SELECT company_name as company, email, status,
             substr(updated_at, 12, 8) as time
      FROM companies
      WHERE processed_date LIKE ? AND status IN ('done','found','not_found')
      ORDER BY updated_at DESC LIMIT 50
    `).all(`${today}%`);

    // Error log (last 50 errors from today)
    const errorLog = db.prepare(`
      SELECT company_name as company, error_message as error,
             substr(updated_at, 12, 8) as time
      FROM companies
      WHERE processed_date LIKE ? AND status IN ('error','retry')
      ORDER BY updated_at DESC LIMIT 50
    `).all(`${today}%`);

    res.json({
      total_companies: total,
      processed,
      found,
      not_found: notFound,
      errors,
      pending,
      success_rate: successRate,
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
      },
      daily_history: dailyHistory,
      recent,
      error_log: errorLog,
    });
  } catch (err) {
    log(`ERROR /api/stats: ${err.message}`);
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
⏰ Session: ${sessionStartTime || '01:00'} - 09:00
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
  log(`EmailHunter API v2.0.0 running on port ${PORT}`);
  log(`Database: /data/emailhunter.db`);
  log(`Schedule: 01:00-09:00 (Asia/Bangkok)`);
  log(`Daily limit: ${DAILY_LIMIT} queries`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Shutting down...');
  db.close();
  process.exit(0);
});
