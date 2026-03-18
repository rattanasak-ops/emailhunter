#!/usr/bin/env node
// Restore CSV export back into EmailHunter SQLite DB
// This script runs INSIDE the API container via docker exec
// Usage: docker cp file.csv emailhunter-api:/tmp/restore.csv
//        docker cp scripts/restore-csv.js emailhunter-api:/tmp/restore-csv.js
//        docker exec emailhunter-api node /tmp/restore-csv.js /tmp/restore.csv

const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const csvFile = process.argv[2] || '/tmp/restore.csv';
const dbPath = '/data/emailhunter.db';

if (!fs.existsSync(csvFile)) {
  console.error(`ERROR: CSV file not found: ${csvFile}`);
  process.exit(1);
}

console.log(`=== EmailHunter CSV Restore ===`);
console.log(`CSV: ${csvFile}`);
console.log(`DB:  ${dbPath}`);

// Read and parse CSV
const content = fs.readFileSync(csvFile, 'utf-8').replace(/^\uFEFF/, ''); // Remove BOM
const lines = content.split('\n').filter(l => l.trim());

console.log(`Total lines: ${lines.length} (including header)`);

// Parse header
const headerLine = lines[0];
const headers = headerLine.split(',').map(h => h.trim().toLowerCase());
console.log(`Headers: ${headers.join(', ')}`);

const colIdx = {
  company_name: headers.indexOf('company_name'),
  email: headers.indexOf('email'),
  all_emails: headers.indexOf('all_emails'),
  source_url: headers.indexOf('source_url'),
  status: headers.indexOf('status'),
  processed_date: headers.indexOf('processed_date'),
};

if (colIdx.company_name === -1) {
  console.error('ERROR: Missing company_name column');
  process.exit(1);
}

// CSV parser (handles quoted fields)
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

// Open DB
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Check current state
const before = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
console.log(`\nDB before restore: ${before} companies`);

if (before > 0) {
  console.log('WARNING: Database already has data. New entries will be added (duplicates skipped by company_name).');
}

// Create unique index on company_name if not exists (for INSERT OR IGNORE)
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_company_name_unique ON companies(company_name)');

// Prepare insert
const insert = db.prepare(`
  INSERT OR IGNORE INTO companies (company_name, email, all_emails, source_url, status, processed_date, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now','localtime'))
`);

let imported = 0;
let duplicates = 0;
let errors = 0;

const insertChunk = db.transaction((rows) => {
  for (const fields of rows) {
    try {
      const name = (fields[colIdx.company_name] || '').trim();
      if (!name) { errors++; continue; }

      const email = colIdx.email >= 0 ? (fields[colIdx.email] || '').trim() || null : null;
      const allEmails = colIdx.all_emails >= 0 ? (fields[colIdx.all_emails] || '').trim() || null : null;
      const sourceUrl = colIdx.source_url >= 0 ? (fields[colIdx.source_url] || '').trim() || null : null;
      const status = colIdx.status >= 0 ? (fields[colIdx.status] || '').trim() || 'pending' : 'pending';
      const date = colIdx.processed_date >= 0 ? (fields[colIdx.processed_date] || '').trim() || null : null;

      const result = insert.run(name, email, allEmails, sourceUrl, status, date);
      if (result.changes > 0) {
        imported++;
      } else {
        duplicates++;
      }
    } catch (e) {
      errors++;
      if (errors <= 5) console.error(`  Row error: ${e.message}`);
    }
  }
});

// Parse all data rows
const dataRows = [];
for (let i = 1; i < lines.length; i++) {
  dataRows.push(parseCSVLine(lines[i]));
}

// Insert in chunks
const CHUNK = 500;
for (let i = 0; i < dataRows.length; i += CHUNK) {
  insertChunk(dataRows.slice(i, i + CHUNK));
  if ((i + CHUNK) % 2000 === 0 || i + CHUNK >= dataRows.length) {
    process.stdout.write(`\rProgress: ${Math.min(i + CHUNK, dataRows.length)}/${dataRows.length}`);
  }
}

console.log('');

// Verify
const after = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
const found = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'found' AND email IS NOT NULL AND email != ''").get().cnt;
const notFound = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'not_found'").get().cnt;
const pending = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('pending', 'retry')").get().cnt;

console.log(`\n=== Restore Complete ===`);
console.log(`Imported:   ${imported}`);
console.log(`Duplicates: ${duplicates}`);
console.log(`Errors:     ${errors}`);
console.log(`\nDB after restore:`);
console.log(`  Total:     ${after}`);
console.log(`  Found:     ${found}`);
console.log(`  Not Found: ${notFound}`);
console.log(`  Pending:   ${pending}`);

db.close();
console.log('\nDone!');
