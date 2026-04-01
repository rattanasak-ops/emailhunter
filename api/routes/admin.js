// ─────────────────────────────────────────────────────────────
// Admin Routes — Import/Export, Backup, Reset, Reports
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const Database = require('better-sqlite3');
const { db, log, todayStr, UPLOAD_DIR, BACKUP_DIR, DATA_DIR, formatNumber, ensureDailyStats, getDailyStats, getProcessedToday, randomBetween } = require('../config/database');
const { ALLOWED_EXTENSIONS } = require('../config/constants');
const { notifyLark, sendLineNotify } = require('../services/notification');
const worker = require('../services/worker');
const search = require('../services/search');

// ─── Multer Setup ────────────────────────────────────────────
const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) cb(null, true);
    else cb(new Error(`ไฟล์ไม่รองรับ: ${ext} — รองรับเฉพาะ ${ALLOWED_EXTENSIONS.join(', ')}`));
  },
});

// ─── Reset ───────────────────────────────────────────────────
router.post('/reset', (req, res) => {
  try {
    db.prepare('DELETE FROM companies').run();
    db.prepare('DELETE FROM daily_stats').run();
    db.prepare('DELETE FROM session_log').run();
    db.prepare('DELETE FROM email_assignments').run();
    worker.resetState();
    log('ALL DATA RESET — companies, daily_stats, session_log, email_assignments cleared');
    res.json({ success: true, message: 'All data has been reset' });
  } catch (err) {
    log(`ERROR /api/reset: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Import Excel ────────────────────────────────────────────
router.post('/import', upload.single('file'), (req, res) => {
  let filePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    filePath = req.file.path;
    log(`Importing file: ${req.file.originalname} (${(req.file.size / 1024 / 1024).toFixed(1)}MB)`);

    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    let rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (rows.length === 0) return res.status(400).json({ error: 'Empty spreadsheet' });

    const headers = Object.keys(rows[0]);
    let companyCol = headers.find(h => /company|บริษัท|ชื่อ|name/i.test(h));
    const taxIdCol = headers.find(h => /tax_id|เลขที่|tax|เลขประจำตัว/i.test(h));
    const industryCol = headers.find(h => /industry|ประเภท|อุตสาหกรรม/i.test(h));

    if (!companyCol && headers.length === 1) {
      log('No header detected, single column — treating as headerless company list');
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
      rows = rawRows.map(r => ({ company_name: String(r[0] || '').trim() })).filter(r => r.company_name);
      companyCol = 'company_name';
    } else if (!companyCol && headers.length > 1) {
      log(`No header match found, using first column "${headers[0]}" as company name`);
      companyCol = headers[0];
    }

    if (!companyCol) {
      return res.status(400).json({ error: 'Cannot detect company name column', headers });
    }

    const insert = db.prepare('INSERT OR IGNORE INTO companies (company_name, tax_id, industry) VALUES (?, ?, ?)');
    let imported = 0, duplicates = 0, errors = 0;
    const CHUNK_SIZE = 1000;

    const insertChunk = db.transaction((chunk) => {
      for (const row of chunk) {
        const name = String(row[companyCol] || '').trim();
        if (!name) { errors++; continue; }
        const taxId = taxIdCol ? String(row[taxIdCol] || '').trim() : null;
        const industry = industryCol ? String(row[industryCol] || '').trim() : null;
        const result = insert.run(name, taxId, industry);
        if (result.changes > 0) imported++;
        else duplicates++;
      }
    });

    for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
      insertChunk(rows.slice(i, i + CHUNK_SIZE));
    }

    log(`Import complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    res.json({ success: true, imported, duplicates, total: rows.length, errors, detected_columns: { company: companyCol, tax_id: taxIdCol || null, industry: industryCol || null } });
  } catch (err) {
    log(`ERROR /api/import: ${err.message}`);
    if (filePath) try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

// ─── Export ──────────────────────────────────────────────────
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) return '"' + str.replace(/"/g, '""') + '"';
  return str;
}

router.get('/export', (req, res) => {
  try {
    const format = req.query.format || 'csv';
    const rows = db.prepare(`
      SELECT company_name, email, all_emails, source_url, status, processed_date
      FROM companies WHERE status IN ('done', 'found', 'not_found') ORDER BY processed_date DESC
    `).all();

    if (format === 'json') {
      res.setHeader('Content-Disposition', `attachment; filename="emailhunter_export_${todayStr()}.json"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.json(rows);
    }

    const BOM = '\uFEFF';
    const header = 'company_name,email,all_emails,source_url,status,processed_date';
    const csvRows = rows.map(r => [csvEscape(r.company_name), csvEscape(r.email), csvEscape(r.all_emails), csvEscape(r.source_url), csvEscape(r.status), csvEscape(r.processed_date)].join(','));
    res.setHeader('Content-Disposition', `attachment; filename="emailhunter_export_${todayStr()}.csv"`);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(BOM + header + '\n' + csvRows.join('\n'));
  } catch (err) {
    log(`ERROR /api/export: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── CSV Restore ─────────────────────────────────────────────
router.post('/restore', upload.single('file'), (req, res) => {
  let filePath = null;
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    filePath = req.file.path;
    const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ error: 'Empty CSV file' });

    const header = lines[0].split(',').map(h => h.trim().toLowerCase());
    const companyIdx = header.indexOf('company_name');
    const emailIdx = header.indexOf('email');
    const allEmailsIdx = header.indexOf('all_emails');
    const sourceUrlIdx = header.indexOf('source_url');
    const statusIdx = header.indexOf('status');
    const dateIdx = header.indexOf('processed_date');
    if (companyIdx === -1) return res.status(400).json({ error: 'Missing company_name column' });

    function parseCSVLine(line) {
      const fields = []; let current = ''; let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"') { if (inQuotes && line[i + 1] === '"') { current += '"'; i++; } else inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { fields.push(current); current = ''; }
        else current += ch;
      }
      fields.push(current);
      return fields;
    }

    const insert = db.prepare(`INSERT OR IGNORE INTO companies (company_name, email, all_emails, source_url, status, processed_date, updated_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))`);
    let imported = 0, duplicates = 0, errors = 0;
    const dataRows = lines.slice(1).map(parseCSVLine);

    db.transaction(() => {
      for (const fields of dataRows) {
        try {
          const name = (fields[companyIdx] || '').trim();
          if (!name) { errors++; continue; }
          const result = insert.run(name,
            emailIdx >= 0 ? (fields[emailIdx] || '').trim() || null : null,
            allEmailsIdx >= 0 ? (fields[allEmailsIdx] || '').trim() || null : null,
            sourceUrlIdx >= 0 ? (fields[sourceUrlIdx] || '').trim() || null : null,
            statusIdx >= 0 ? (fields[statusIdx] || '').trim() || 'pending' : 'pending',
            dateIdx >= 0 ? (fields[dateIdx] || '').trim() || null : null);
          if (result.changes > 0) imported++; else duplicates++;
        } catch { errors++; }
      }
    })();

    log(`Restore complete: ${imported} imported, ${duplicates} duplicates, ${errors} errors`);
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    res.json({ success: true, imported, duplicates, errors, total: dataRows.length });
  } catch (err) {
    log(`ERROR /api/restore: ${err.message}`);
    if (filePath) try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
});

// ─── Retry not_found ─────────────────────────────────────────
router.post('/retry-not-found', (req, res) => {
  try {
    const { date_from, date_to, limit: maxRetry } = req.body || {};
    const dateFrom = date_from || '2026-03-18';
    const dateTo = date_to || '2026-03-19';
    const retryLimit = Math.min(maxRetry || 5000, 10000);

    const result = db.prepare(`
      UPDATE companies SET status = 'pending', retry_count = 0, error_message = NULL
      WHERE status = 'not_found' AND email IS NULL AND processed_date >= ? AND processed_date < date(?, '+1 day')
      LIMIT ?
    `).run(dateFrom, dateTo, retryLimit);

    log(`Retry not_found: ${result.changes} companies reset (${dateFrom} to ${dateTo})`);
    notifyLark('Retry Not-Found', `**${formatNumber(result.changes)} บริษัท** กลับเข้า queue (${dateFrom} ถึง ${dateTo})`, 'blue');
    res.json({ success: true, retried: result.changes, date_range: `${dateFrom} to ${dateTo}` });
  } catch (err) {
    log(`ERROR /api/retry-not-found: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Reports ─────────────────────────────────────────────────
function generateReport() {
  const today = todayStr();
  const stats = getDailyStats(today);
  const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
  const allProcessed = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found','not_found','error')").get().cnt;
  const wc = worker.getWorkCycle();
  const st = worker.getState();

  const processedToday = stats.processed || 0;
  const foundToday = stats.found || 0;
  const notFoundToday = stats.not_found || 0;
  const errorsToday = stats.errors || 0;
  const foundPct = processedToday > 0 ? ((foundToday / processedToday) * 100).toFixed(1) : '0.0';
  const progressPct = total > 0 ? ((allProcessed / total) * 100).toFixed(1) : '0.0';
  const remaining = total - allProcessed;
  const etaDays = processedToday > 0 ? Math.ceil(remaining / processedToday) : '???';

  let currentSpeed = 0;
  if (st.recentSpeeds.length >= 2) {
    const elapsed = (st.recentSpeeds[st.recentSpeeds.length - 1] - st.recentSpeeds[0]) / 1000 / 60;
    currentSpeed = elapsed > 0 ? (st.recentSpeeds.length / elapsed).toFixed(1) : '0.0';
  }

  const fmt = (n) => Number(n).toLocaleString();
  return `\n📊 EmailHunter — รายงานประจำวัน\n📅 ${today} | Cycles: ${wc.cycleCount}\n─────\n✅ ประมวลผล: ${fmt(processedToday)}\n📧 เจอ: ${fmt(foundToday)} (${foundPct}%)\n📈 ${fmt(allProcessed)}/${fmt(total)} (${progressPct}%) ETA ~${etaDays}d\n⚡ ${currentSpeed}/min`;
}

router.post('/report/send', async (req, res) => {
  try {
    await sendLineNotify(generateReport());
    log('LINE report sent');
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

router.post('/report/schedule-check', async (req, res) => {
  try {
    const hour = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok', hour: 'numeric', hour12: false }), 10);
    if (hour >= 9) {
      let reportSent = false;
      try { await sendLineNotify(generateReport()); reportSent = true; } catch { /* ignore */ }
      worker.logSession();
      return res.json({ should_stop: true, report_sent: reportSent });
    }
    res.json({ should_stop: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Backup System ───────────────────────────────────────────
function performBackup() {
  try {
    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    if (total === 0) { log('Backup skipped — empty'); return; }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = path.join(BACKUP_DIR, `emailhunter_${timestamp}.db`);
    db.backup(backupPath).then(() => {
      log(`Backup created: ${backupPath} (${total} companies)`);
      const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('emailhunter_') && f.endsWith('.db')).sort().reverse();
      for (let i = 7; i < backups.length; i++) {
        fs.unlinkSync(path.join(BACKUP_DIR, backups[i]));
        log(`Deleted old backup: ${backups[i]}`);
      }
    }).catch(err => log(`Backup FAILED: ${err.message}`));
  } catch (err) { log(`Backup error: ${err.message}`); }
}

// Auto-backup every 6 hours + on startup
setInterval(performBackup, 6 * 60 * 60 * 1000);
setTimeout(performBackup, 5000);

router.post('/backup', (req, res) => {
  try { performBackup(); res.json({ success: true, message: 'Backup initiated' }); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/backups', (req, res) => {
  try {
    const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith('emailhunter_') && f.endsWith('.db')).sort().reverse()
      .map(f => { const stat = fs.statSync(path.join(BACKUP_DIR, f)); return { name: f, size_mb: (stat.size / 1024 / 1024).toFixed(1), date: stat.mtime.toISOString() }; });
    res.json({ backups });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/backup/restore', (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Backup name required' });
    const backupPath = path.join(BACKUP_DIR, name);
    if (!fs.existsSync(backupPath)) return res.status(404).json({ error: 'Backup not found' });
    const testDb = new Database(backupPath, { readonly: true });
    const count = testDb.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    testDb.close();
    fs.copyFileSync(backupPath, path.join(DATA_DIR, 'emailhunter.db'));
    log(`Restored from backup: ${name} (${count} companies)`);
    res.json({ success: true, message: `Restored ${count} companies. Restart container to apply.` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Export for graceful shutdown
module.exports = router;
module.exports.performBackup = performBackup;
module.exports.csvEscape = csvEscape;
