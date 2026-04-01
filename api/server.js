// ─────────────────────────────────────────────────────────────
// EmailHunter API — v4.0.0
// Modular backend service with anti-blocking engine
// ─────────────────────────────────────────────────────────────

process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const { db, log } = require('./config/database');
const authMiddleware = require('./middleware/auth');
const { performBackup, csvEscape } = require('./routes/admin');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3456;

// ─── Middleware ───────────────────────────────────────────────
app.use(express.json());

// CORS
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:8890,http://127.0.0.1:8890').split(',').map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!origin || ALLOWED_ORIGINS.includes(origin) || ALLOWED_ORIGINS.includes('*')) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Auth
app.use(authMiddleware);

// ─── Health Check (before routes — no auth needed) ───────────
app.get('/api/health', (req, res) => {
  try {
    const row = db.prepare('SELECT COUNT(*) as cnt FROM companies').get();
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()), db_size: row.cnt });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ─── Routes ──────────────────────────────────────────────────
app.use('/api/session', require('./routes/session'));
app.use('/api/stats', require('./routes/stats'));
app.use('/api', require('./routes/admin'));

// ─── Global Error Handler ────────────────────────────────────
app.use((err, req, res, next) => {
  log(`Unhandled error: ${err.message}`);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start Server ────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const worker = require('./services/worker');
  log(`EmailHunter API v4.0.0 running on port ${PORT}`);
  log(`Database: /data/emailhunter.db`);
  log(`Mode: Work Cycle (45-90 min work / 3-40 min rest)`);
  log(`Daily limit: ${worker.getDailyLimit()} queries`);
  log(`Lark: ${process.env.LARK_APP_ID ? 'configured' : 'not configured'}`);
  log(`Auth: ${process.env.API_KEY ? 'enabled' : 'disabled (no API_KEY set)'}`);
});

// ─── Graceful Shutdown ───────────────────────────────────────
function shutdown() {
  log('Shutting down... creating backup');
  performBackup();

  // CSV auto-export
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    if (total > 0) {
      const rows = db.prepare('SELECT company_name, email, all_emails, source_url, status, processed_date FROM companies ORDER BY id').all();
      const BOM = '\uFEFF';
      const header = 'company_name,email,all_emails,source_url,status,processed_date';
      const csvRows = rows.map(r => [csvEscape(r.company_name), csvEscape(r.email), csvEscape(r.all_emails), csvEscape(r.source_url), csvEscape(r.status), csvEscape(r.processed_date)].join(','));
      const { todayStr } = require('./config/database');
      const BACKUP_DIR = path.join('/data', 'backups');
      fs.writeFileSync(path.join(BACKUP_DIR, `auto_export_${todayStr()}.csv`), BOM + header + '\n' + csvRows.join('\n'), 'utf-8');
      log(`Auto CSV export: ${rows.length} rows`);
    }
  } catch (err) { log(`CSV export error: ${err.message}`); }

  db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
