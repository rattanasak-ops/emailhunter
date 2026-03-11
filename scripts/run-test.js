const http = require('http');
const https = require('https');

// ─── HTTP helpers ────────────────────────────────────────────
function get(path) {
  return new Promise((resolve, reject) => {
    http.get('http://localhost:3456' + path, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
}

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ hostname: 'localhost', port: 3456, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { resolve({ raw: d }); } });
    });
    req.on('error', reject);
    req.write(data); req.end();
  });
}

function searchSearXNG(query, engines) {
  return new Promise(ok => {
    const url = '/search?q=' + encodeURIComponent(query) + '&format=json&engines=' + (engines || 'google');
    http.get('http://emailhunter-searxng:8080' + url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { ok(JSON.parse(d)); } catch(x) { ok({ results: [] }); } });
    }).on('error', () => ok({ results: [] }));
  });
}

function fetchPage(url, timeout) {
  return new Promise(ok => {
    const timer = setTimeout(() => ok(''), timeout || 8000);
    try {
      const mod = url.startsWith('https') ? https : http;
      mod.get(url, { timeout: timeout || 8000, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' } }, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(timer);
          return fetchPage(res.headers.location, timeout).then(ok);
        }
        let d = ''; res.on('data', c => { d += c; if (d.length > 500000) res.destroy(); });
        res.on('end', () => { clearTimeout(timer); ok(d); });
        res.on('error', () => { clearTimeout(timer); ok(''); });
      }).on('error', () => { clearTimeout(timer); ok(''); });
    } catch(e) { clearTimeout(timer); ok(''); }
  });
}

// ─── Email extraction & filtering ────────────────────────────
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

const JUNK_PREFIXES = ['noreply@','no-reply@','example@','test@','webmaster@','postmaster@','abuse@','mailer-daemon@','spam@','user@','root@','daemon@','nobody@'];

const BLACKLIST_DOMAINS = [
  'connectbizs.com','jobthai.com','creden.co','longdo.com',
  'yellowpages.co.th','trustonline.co.th','thaidbs.com',
  'thaibizdir.com','registered.in.th','dataforthai.com',
  'smeregister.com','infoquest.co.th','checkraka.com',
  'jobsdb.com','jobbkk.com','indeed.com','linkedin.com',
  'facebook.com','google.com','wikipedia.org',
  'thaijobsgov.com','nationejobs.com','jobth.com',
  'pantip.com','sanook.com','kapook.com',
  'sentry.io','wixpress.com','placeholder.com','example.com',
];

const JUNK_EXT = ['.png','.jpg','.gif','.svg','.webp','.css','.js'];

function isBadEmail(e) {
  const l = e.toLowerCase();
  if (JUNK_PREFIXES.some(p => l.startsWith(p))) return true;
  if (JUNK_EXT.some(x => l.endsWith(x))) return true;
  const domain = l.split('@')[1] || '';
  if (BLACKLIST_DOMAINS.some(bl => domain === bl || domain.endsWith('.' + bl))) return true;
  return false;
}

function priority(e) {
  const l = e.toLowerCase();
  if (l.startsWith('info@')) return 1;
  if (l.startsWith('contact@')) return 2;
  if (l.startsWith('sales@')) return 3;
  if (l.startsWith('admin@')) return 4;
  if (l.startsWith('support@')) return 5;
  if (l.startsWith('hr@')) return 6;
  return 7;
}

function extractEmails(text) {
  const raw = text.match(EMAIL_REGEX) || [];
  return [...new Set(raw)].filter(e => !isBadEmail(e)).sort((a, b) => priority(a) - priority(b));
}

// ─── Find contact page URLs ─────────────────────────────────
function findContactUrls(html, baseUrl) {
  const urls = [];
  const patterns = [
    /href=["']([^"']*(?:contact|about|ติดต่อ|เกี่ยวกับ)[^"']*)["']/gi,
  ];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(html)) !== null) {
      let url = m[1];
      if (url.startsWith('/')) {
        try { url = new URL(url, baseUrl).href; } catch(e) { continue; }
      }
      if (url.startsWith('http') && urls.length < 3) urls.push(url);
    }
  }
  return urls;
}

// ─── Process one company ─────────────────────────────────────
async function processOne() {
  const data = await get('/api/companies/next?force=true');
  if (!data.company || (data.session && data.session.should_stop)) return null;

  const company = data.company;
  const search = data.search;
  const name = company.company_name;
  process.stdout.write('[' + company.id + '] ' + name);

  // ── Layer 1: SearXNG Search ──
  const sr = await searchSearXNG(search.query, search.engines);
  let allText = '';
  const resultUrls = [];
  for (const r of (sr.results || [])) {
    allText += ' ' + (r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '');
    if (r.url && resultUrls.length < 5) resultUrls.push(r.url);
  }

  let emails = extractEmails(allText);
  let sourceUrl = '';
  let foundLayer = '';

  if (emails.length > 0) {
    // Find source URL for best email
    for (const r of (sr.results || [])) {
      if (((r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '')).includes(emails[0])) {
        sourceUrl = r.url || '';
        break;
      }
    }
    foundLayer = 'search';
  }

  // ── Layer 2: Contact Page Crawl (if not found) ──
  if (emails.length === 0 && resultUrls.length > 0) {
    for (const url of resultUrls.slice(0, 2)) {
      try {
        const html = await fetchPage(url, 8000);
        if (!html) continue;

        // Extract from main page
        const pageEmails = extractEmails(html);
        if (pageEmails.length > 0) {
          emails = pageEmails;
          sourceUrl = url;
          foundLayer = 'website';
          break;
        }

        // Find and fetch contact/about pages
        const contactUrls = findContactUrls(html, url);
        for (const cu of contactUrls) {
          const chtml = await fetchPage(cu, 6000);
          const cemails = extractEmails(chtml || '');
          if (cemails.length > 0) {
            emails = cemails;
            sourceUrl = cu;
            foundLayer = 'contact_page';
            break;
          }
        }
        if (emails.length > 0) break;
      } catch(e) { /* skip */ }
    }
  }

  // ── Layer 3: Facebook Page Search (if still not found) ──
  if (emails.length === 0) {
    const fbQuery = '"' + name + '" site:facebook.com email';
    const fbSr = await searchSearXNG(fbQuery, 'google');
    let fbText = '';
    for (const r of (fbSr.results || [])) {
      fbText += ' ' + (r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '');
    }
    const fbEmails = extractEmails(fbText);
    if (fbEmails.length > 0) {
      emails = fbEmails;
      foundLayer = 'facebook';
      for (const r of (fbSr.results || [])) {
        if (((r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '')).includes(fbEmails[0])) {
          sourceUrl = r.url || '';
          break;
        }
      }
    }
  }

  // ── Layer 4: Retry with different query patterns ──
  if (emails.length === 0) {
    const retryQueries = [
      name + ' email @gmail.com OR @hotmail.com OR @yahoo.com',
      name + ' ติดต่อ โทร email',
    ];
    for (const q of retryQueries) {
      const rsr = await searchSearXNG(q, 'google,bing');
      let rtext = '';
      for (const r of (rsr.results || [])) {
        rtext += ' ' + (r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '');
      }
      const remails = extractEmails(rtext);
      if (remails.length > 0) {
        emails = remails;
        foundLayer = 'retry_search';
        for (const r of (rsr.results || [])) {
          if (((r.title || '') + ' ' + (r.content || '') + ' ' + (r.url || '')).includes(remails[0])) {
            sourceUrl = r.url || '';
            break;
          }
        }
        break;
      }
    }
  }

  // ── Save result ──
  const best = emails[0] || null;
  const status = best ? 'found' : 'not_found';
  const result = await post('/api/companies/' + company.id + '/result', {
    email: best, all_emails: emails, source_url: sourceUrl, status: status, source: foundLayer || 'none'
  });

  if (best) {
    console.log(' -> ' + best + ' [' + foundLayer + '] ' + (result.success ? 'OK' : 'FAIL'));
  } else {
    console.log(' -> NOT FOUND');
  }

  // 3 second delay between companies
  await new Promise(r => setTimeout(r, 3000));
  return { company: name, email: best, status: status, layer: foundLayer };
}

// ─── Main ────────────────────────────────────────────────────
async function run() {
  console.log('=== EmailHunter Test Run (5-Layer) ===');
  console.log('Layers: Search -> Contact Page -> Facebook -> Retry Query -> Filter\n');
  let count = 0, found = 0;
  const layers = {};
  while (true) {
    const r = await processOne();
    if (!r) break;
    count++;
    if (r.email) {
      found++;
      layers[r.layer] = (layers[r.layer] || 0) + 1;
    }
  }
  const pct = count > 0 ? Math.round(found / count * 100) : 0;
  console.log('\n=== Results ===');
  console.log('Total: ' + count + ' | Found: ' + found + ' (' + pct + '%)');
  console.log('By layer:');
  for (const [k, v] of Object.entries(layers)) {
    console.log('  ' + k + ': ' + v);
  }
}

run().catch(e => console.error('FATAL:', e.message));
