// Backfill daily_stats from companies processed_date
// Run inside API container: docker exec emailhunter-api node /tmp/backfill-stats.js

const Database = require('better-sqlite3');
const db = new Database('/data/emailhunter.db');

console.log('=== Backfill daily_stats ===');

// Get daily counts from companies table
const rows = db.prepare(`
  SELECT
    DATE(processed_date) as date,
    COUNT(*) as processed,
    SUM(CASE WHEN status IN ('found','done') AND email IS NOT NULL AND email != '' THEN 1 ELSE 0 END) as found,
    SUM(CASE WHEN status = 'not_found' THEN 1 ELSE 0 END) as not_found,
    SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
  FROM companies
  WHERE processed_date IS NOT NULL
  GROUP BY DATE(processed_date)
  ORDER BY date
`).all();

console.log('Found ' + rows.length + ' dates with data\n');

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
    if (!r.date) continue;
    upsert.run(r.date, r.processed, r.found, r.not_found, r.errors);
    console.log(r.date + ': processed=' + r.processed + ' found=' + r.found + ' not_found=' + r.not_found);
  }
});
tx();

// Verify
const stats = db.prepare('SELECT * FROM daily_stats ORDER BY date').all();
console.log('\nDaily stats: ' + stats.length + ' entries');
let totalProcessed = 0, totalFound = 0, totalNotFound = 0;
for (const s of stats) {
  totalProcessed += s.processed;
  totalFound += s.found;
  totalNotFound += s.not_found;
}
console.log('Sum: processed=' + totalProcessed + ' found=' + totalFound + ' not_found=' + totalNotFound);
db.close();
console.log('Done!');
