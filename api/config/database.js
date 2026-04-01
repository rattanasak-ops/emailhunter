// ─────────────────────────────────────────────────────────────
// Database Setup, Migrations & Helpers
// ─────────────────────────────────────────────────────────────

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = '/data';
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

// Ensure directories exist
[DATA_DIR, UPLOAD_DIR, BACKUP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const db = new Database(path.join(DATA_DIR, 'emailhunter.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

function log(msg) {
  const now = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
  console.log(`[${now}] ${msg}`);
}

// ─── Create Tables ───────────────────────────────────────────
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

  CREATE TABLE IF NOT EXISTS email_assignments (
    email TEXT PRIMARY KEY,
    assign_count INTEGER DEFAULT 1,
    last_assigned_to TEXT,
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  );
`);

log('Database initialized');

// ─── Migrations ──────────────────────────────────────────────

// Migration: UNIQUE index on company_name
try {
  const idxInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_company_name'").get();
  if (!idxInfo || !idxInfo.sql || !idxInfo.sql.includes('UNIQUE')) {
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

// Migration: rejection tracking columns
try {
  const cols = db.prepare("PRAGMA table_info('companies')").all().map(c => c.name);
  if (!cols.includes('rejection_reason')) {
    db.exec("ALTER TABLE companies ADD COLUMN rejection_reason TEXT");
    log('Migration: added rejection_reason column');
  }
  if (!cols.includes('last_pattern_used')) {
    db.exec("ALTER TABLE companies ADD COLUMN last_pattern_used TEXT");
    log('Migration: added last_pattern_used column');
  }
  if (!cols.includes('last_engines_used')) {
    db.exec("ALTER TABLE companies ADD COLUMN last_engines_used TEXT");
    log('Migration: added last_engines_used column');
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_rejection_reason ON companies(rejection_reason)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_processed_date ON companies(processed_date)");
} catch (e) {
  log(`Migration (rejection tracking) warning: ${e.message}`);
}

// ─── Auto-sync daily_stats on startup ────────────────────────
(function autoSyncDailyStats() {
  try {
    const companyTotal = db.prepare(`SELECT COUNT(*) as cnt FROM companies WHERE status IN ('found','done','not_found','error')`).get().cnt;
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
          processed = excluded.processed, found = excluded.found,
          not_found = excluded.not_found, errors = excluded.errors
      `);

      db.transaction(() => {
        for (const r of rows) {
          if (r.date) upsert.run(r.date, r.processed, r.found, r.not_found, r.errors);
        }
      })();

      log(`daily_stats backfilled: ${rows.length} dates synced`);
    } else {
      log('daily_stats in sync');
    }
  } catch (err) {
    log(`daily_stats sync error: ${err.message}`);
  }
})();

// ─── Helper Functions ────────────────────────────────────────

function todayStr() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

function nowTimeStr() {
  return new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
}

function nowISOStr() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Bangkok' }).replace(' ', 'T');
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

function formatNumber(n) {
  return Number(n || 0).toLocaleString();
}

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

module.exports = {
  db,
  log,
  DATA_DIR,
  UPLOAD_DIR,
  BACKUP_DIR,
  todayStr,
  nowTimeStr,
  nowISOStr,
  ensureDailyStats,
  getDailyStats,
  getProcessedToday,
  formatNumber,
  randomBetween,
};
