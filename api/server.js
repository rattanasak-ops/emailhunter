// ─────────────────────────────────────────────────────────────
// EmailHunter API — v4.1.0
// Modular backend service with anti-blocking engine
// ─────────────────────────────────────────────────────────────

process.env.TZ = 'Asia/Bangkok';

const express = require('express');
const { db, log, todayStr, formatNumber } = require('./config/database');
const authMiddleware = require('./middleware/auth');
const { performBackup, csvEscape } = require('./routes/admin');
const { notifyLark, configuredValue, getConfiguredWebhookUrl } = require('./services/notification');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3456;
let shuttingDown = false;

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

// ─── Health Check ─────────────────────────────────────────────
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
  const larkConfigured = !!(getConfiguredWebhookUrl() || configuredValue(process.env.LARK_APP_ID));

  log(`EmailHunter API v4.1.0 running on port ${PORT}`);
  log(`Database: /data/emailhunter.db`);
  log(`Mode: Work Cycle (45-90 min work / 3-40 min rest)`);
  log(`Daily limit: ${worker.getDailyLimit()} queries`);
  log(`Lark: ${larkConfigured ? 'configured' : 'not configured'}`);
  log(`Auth: ${process.env.API_KEY ? 'enabled' : 'disabled (no API_KEY set)'}`);

  // ─── Auto-start worker on boot ───────────────────────────
  setTimeout(() => {
    try {
      const pending = db.prepare("SELECT COUNT(*) as c FROM companies WHERE status IN ('pending','retry')").get().c;
      if (pending > 0) {
        worker.start();
        log(`Auto-start: worker started (${formatNumber(pending)} pending)`);
        notifyLark('🚀 Worker Started', `**Auto-start on boot** | Pending: ${formatNumber(pending)} | Limit: ${formatNumber(worker.getDailyLimit())}`, 'green');
      } else {
        log('Auto-start: no pending companies');
      }
    } catch (e) {
      log(`Auto-start error: ${e.message}`);
    }
  }, 3000);

  // ─── Watchdog — restart worker if unexpectedly idle ──────
  // Runs every 10 minutes. Restarts only if: not manually stopped + has pending work + idle >15 min
  setInterval(() => {
    try {
      const state = worker.getState();
      if (state.workerRunning) return; // healthy, nothing to do
      if (state.manualMode === 'stopped') return; // manually stopped — respect user's choice

      const pending = db.prepare("SELECT COUNT(*) as c FROM companies WHERE status IN ('pending','retry')").get().c;
      if (pending === 0) return; // all done

      const idleMs = state.idleSince ? Date.now() - state.idleSince : Infinity;
      const idleMin = Math.round(idleMs / 60000);
      if (idleMs < 15 * 60 * 1000) return; // grace period 15 min (covers normal rest cycles)

      log(`Watchdog: worker idle ${idleMin} min with ${pending} pending — restarting`);
      worker.start();
      notifyLark('⚠️ Watchdog Auto-Restart', `Worker หยุดทำงาน **${idleMin} นาที** โดยไม่คาดคิด\nPending: ${formatNumber(pending)} | Auto-restarted แล้ว`, 'yellow');
    } catch (e) {
      log(`Watchdog error: ${e.message}`);
    }
  }, 10 * 60 * 1000);

  // ─── Daily Summary — ส่งทุกเที่ยงคืน ────────────────────
  scheduleDailySummary(worker);
});

// ─── Daily Summary Scheduler ─────────────────────────────────
function scheduleDailySummary(worker) {
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 30, 0); // 00:00:30 วันถัดไป
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();

  setTimeout(() => {
    sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntilMidnight);

  log(`Daily summary scheduled in ${Math.round(msUntilMidnight / 3600000 * 10) / 10}h`);
}

function sendDailySummary() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
    const stats = db.prepare('SELECT * FROM daily_stats WHERE date = ?').get(dateStr);
    const total = db.prepare('SELECT COUNT(*) as c FROM companies').get().c;
    const processed = db.prepare("SELECT COUNT(*) as c FROM companies WHERE status NOT IN ('pending','retry')").get().c;
    const pending = db.prepare("SELECT COUNT(*) as c FROM companies WHERE status IN ('pending','retry')").get().c;

    if (!stats || stats.processed === 0) {
      notifyLark('🔴 Daily Summary — ไม่มีงาน!', `**${dateStr}** ไม่มีการประมวลผลเลย!\nPending: ${formatNumber(pending)} รายการรอดำเนินการ\n\n⚠️ Worker อาจ down — กรุณาตรวจสอบ`, 'red');
      return;
    }

    const rate = stats.processed > 0 ? Math.round(stats.found / stats.processed * 100) : 0;
    const pct = total > 0 ? Math.round(processed / total * 100) : 0;
    notifyLark('📊 Daily Summary', `**${dateStr}**\nประมวลผล: ${formatNumber(stats.processed)} | Found: ${formatNumber(stats.found)} (${rate}%)\nBlocks: ${stats.blocks_detected || 0}\n\nรวม: ${formatNumber(processed)}/${formatNumber(total)} (${pct}%) | เหลือ: ${formatNumber(pending)}`, 'blue');
  } catch (e) {
    log(`Daily summary error: ${e.message}`);
  }
}

// ─── Graceful Shutdown ───────────────────────────────────────
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('Shutting down...');
  performBackup({ reason: 'shutdown' });

  try {
    const exportOnShutdown = String(process.env.CSV_EXPORT_ON_SHUTDOWN || 'false').toLowerCase() === 'true';
    if (!exportOnShutdown) {
      log('Auto CSV export skipped on shutdown');
      db.close();
      process.exit(0);
    }
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    if (total > 0) {
      const rows = db.prepare('SELECT company_name, email, all_emails, source_url, status, processed_date FROM companies ORDER BY id').all();
      const BOM = '\uFEFF';
      const header = 'company_name,email,all_emails,source_url,status,processed_date';
      const csvRows = rows.map(r => [csvEscape(r.company_name), csvEscape(r.email), csvEscape(r.all_emails), csvEscape(r.source_url), csvEscape(r.status), csvEscape(r.processed_date)].join(','));
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
process.on('unhandledRejection', (err) => {
  log(`Unhandled rejection: ${err && err.stack ? err.stack : err}`);
});
process.on('uncaughtException', (err) => {
  log(`Uncaught exception: ${err && err.stack ? err.stack : err}`);
  shutdown();
});
