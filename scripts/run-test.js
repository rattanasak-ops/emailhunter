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

const JUNK_PREFIXES = ['noreply@','no-reply@','example@','test@','webmaster@','postmaster@','abuse@','mailer-daemon@','spam@','user@','root@','daemon@','nobody@','saraban@','saraban_'];

// Allowed short local parts (won't be filtered by length check)
const ALLOWED_SHORT = ['info','sales','contact','sale','hr','admin','acc','fax'];

const BLACKLIST_DOMAINS = [
  // Directory / aggregator sites
  'connectbizs.com','jobthai.com','creden.co','longdo.com',
  'yellowpages.co.th','trustonline.co.th','thaidbs.com',
  'thaibizdir.com','registered.in.th','dataforthai.com',
  'smeregister.com','infoquest.co.th','checkraka.com',
  'jobsdb.com','jobbkk.com','indeed.com','linkedin.com',
  'facebook.com','google.com','wikipedia.org',
  'thaijobsgov.com','nationejobs.com','jobth.com',
  'pantip.com','sanook.com','kapook.com',
  'sentry.io','wixpress.com','placeholder.com','example.com',
  // Recruitment / HR platforms
  'trustmail.jobthai','getlinks.com','prtr.com','adecco.co.th',
  'manpower.co.th','randstad.co.th','roberthalf.co.th',
  // Banks
  'kasikornbank.com','kbank.com','scb.co.th','bangkokbank.com',
  'ktb.co.th','krungsri.com','tmb.co.th','ttbbank.com',
  'gsb.or.th','baac.or.th','ghbank.co.th','tisco.co.th',
  'lhbank.co.th','cimbthai.com','uob.co.th','thanachartbank.co.th',
  // Big retail / corporate
  'siammakro.co.th','makro.co.th','cpall.co.th','7eleven.co.th',
  'bigc.co.th','lotuss.com','central.co.th','homepro.co.th',
  'doikham.co.th','teleinfomedia.co.th',
  // Unrelated companies found in test
  'tencent.co.th','roblox.com','sermsukplc.com','thespinoff.co.nz',
  'kex-express.com','autohome.com.cn','btnet.com.tw','aui.ma',
  'record-a.autohome.com.cn','ponpe.com','smjip.com',
  'atta.or.th','warin.co.th','menatransport.co.th',
  'btacia.co.th','uaeconsultant.com','zainoifb.com',
  'ideal1world.com','168studioandsupply.com','ie.co.th',
  'asianet.co.th','sgb.co.th',
  // Chinese / foreign junk domains
  'zhihu.com','pizzaexpress.cn',
  // Thai platforms / unrelated from round 4
  'renthub.in.th','hrcenter.co.th','sritranggroup.com',
  'amjakastudio.co.th','hinothailand.com','optasiacapital.com',
  'smooth-e.com','reddoorsamsen.com','accellence.co.th',
  'mission-t.co.th','vichai.group','degree.plus',
  'baanpattayagroup.com','idinarchitects.com',
  'worldpump-wpm.com','jwtech.co.th','xplus.co.th',
  // Big Thai corporates from round 5
  'centralpattana.co.th','scg.com','scgchemicals.com',
  'ttwplc.com','oic.or.th','sam.or.th','thnic.co.th',
  'lmwn.com','systems.co.th',
  // Foreign unrelated from round 5
  'ahlsell.se','startuptalky.com','dezpax.com',
  'pronalityacademy.com','thaiinternships.com',
  'lifestyletech.co.th','jorakay.co.th','prompt1992.com',
  'gfreight.co.th','qbic.co.th','yellbkk.com',
  // Hospitals / unrelated from round 6
  'thainakarin.co.th','bumrungrad.com','bdms.co.th',
  // Microsoft / tech support
  'microsoft.com','apple.com','support.com',
];

const GENERIC_PROVIDERS = [
  'gmail.com','hotmail.com','yahoo.com','outlook.com','live.com',
  'hotmail.co.th','yahoo.co.th','icloud.com','me.com',
  'protonmail.com','mail.com','gmx.com',
];

const JUNK_EXT = ['.png','.jpg','.gif','.svg','.webp','.css','.js'];

// Track duplicate emails across companies
const seenEmails = {};

function isBadEmail(e) {
  const l = e.toLowerCase();
  if (JUNK_PREFIXES.some(p => l.startsWith(p))) return true;
  if (JUNK_EXT.some(x => l.endsWith(x))) return true;
  if (l.includes('%20')) return true; // URL-encoded junk

  const [localPart, domain] = l.split('@');
  if (!domain) return true;

  // Block ALL government emails (*.go.th)
  if (domain.endsWith('.go.th')) return true;

  // Block Chinese domains (*.cn) — not relevant for Thai companies
  if (domain.endsWith('.cn')) return true;

  // Block other foreign TLDs unlikely for Thai SMEs
  const foreignTLDs = ['.se','.de','.fr','.ru','.kr','.jp','.tw','.br','.mx','.nz','.ma'];
  if (foreignTLDs.some(tld => domain.endsWith(tld))) return true;

  // Block university/academic emails
  if (domain.endsWith('.ac.th') || domain.endsWith('.edu')) return true;

  // Block short/junk local parts (but keep info@, sales@, contact@ etc.)
  if (localPart.length < 3 && !ALLOWED_SHORT.includes(localPart)) return true;

  // Block obvious junk patterns
  if (/^x{3,}$/.test(localPart)) return true; // xxxx@
  if (/^\d{1,3}$/.test(localPart)) return true; // 25@, 1@

  if (BLACKLIST_DOMAINS.some(bl => domain === bl || domain.endsWith('.' + bl))) return true;
  return false;
}

// Extract English keywords from company name
function extractEnglishParts(name) {
  return (name.match(/[a-zA-Z]{3,}/g) || []).map(e => e.toLowerCase());
}

function isDomainRelated(domain, companyName) {
  const domainBase = domain.split('.')[0].toLowerCase();
  if (domainBase.length < 2) return false;

  const cleanName = companyName
    .replace(/บริษัท|จำกัด|มหาชน|\(ประเทศไทย\)|ห้างหุ้นส่วน|สามัญ/g, '')
    .replace(/[\s().,\-\/&]/g, '')
    .toLowerCase();

  const englishParts = extractEnglishParts(companyName);

  // Direct match
  if (cleanName.includes(domainBase) || domainBase.includes(cleanName.slice(0, 4))) return true;
  // English part match
  if (englishParts.some(ep => domainBase.includes(ep) || ep.includes(domainBase))) return true;
  // Abbreviation match
  const initials = companyName.replace(/บริษัท|จำกัด|มหาชน|\(ประเทศไทย\)|ห้างหุ้นส่วน|สามัญ/g, '').trim().split(/\s+/).map(w => w[0] || '').join('').toLowerCase();
  if (initials.length >= 2 && domainBase.includes(initials)) return true;

  return false;
}

function scoreEmail(e, companyName) {
  const l = e.toLowerCase();
  const [localPart, domain] = l.split('@');
  if (!domain) return -10;
  const domainBase = domain.split('.')[0];

  // Already seen for another company → directory/aggregator email
  if ((seenEmails[l] || 0) >= 1) return -10;

  // Generic provider (gmail, hotmail)
  if (GENERIC_PROVIDERS.includes(domain)) {
    const englishParts = extractEnglishParts(companyName);
    if (englishParts.some(ep => localPart.includes(ep))) return 60; // gmail with company ref
    if (['info', 'sales', 'contact', 'hr', 'admin'].some(p => localPart.startsWith(p))) return 40;
    return 25; // random gmail — low quality
  }

  // Domain related to company → high quality
  if (isDomainRelated(domain, companyName)) {
    if (['info', 'contact', 'sales', 'hr', 'admin', 'support'].some(p => localPart.startsWith(p))) return 120;
    return 100;
  }

  // .co.th domains — likely a real Thai company
  if (domain.endsWith('.co.th')) {
    if (['info', 'contact', 'sales', 'hr', 'admin', 'support', 'service'].some(p => localPart.startsWith(p))) return 35;
    return 25;
  }

  // .com domains without match
  if (domain.endsWith('.com')) {
    if (['info', 'contact', 'sales', 'hr', 'admin'].some(p => localPart.startsWith(p))) return 25;
    return 15;
  }

  return 20; // unknown TLD
}

function extractEmails(text, companyName) {
  const raw = text.match(EMAIL_REGEX) || [];
  const unique = [...new Set(raw)].filter(e => !isBadEmail(e));

  if (!companyName) return unique;

  // Score and sort — minimum score 20 to filter out wrong-company emails
  const MIN_SCORE = 20;
  return unique
    .map(e => ({ email: e, score: scoreEmail(e, companyName) }))
    .filter(x => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .map(x => x.email);
}

function trackEmail(email) {
  if (!email) return;
  const l = email.toLowerCase();
  seenEmails[l] = (seenEmails[l] || 0) + 1;
}

function getConfidence(email, companyName) {
  if (!email) return 'none';
  const s = scoreEmail(email, companyName);
  if (s >= 100) return 'HIGH';
  if (s >= 50) return 'MED';
  return 'LOW';
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

  let emails = extractEmails(allText, name);
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
        const pageEmails = extractEmails(html, name);
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
          const cemails = extractEmails(chtml || '', name);
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
    const fbEmails = extractEmails(fbText, name);
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
      const remails = extractEmails(rtext, name);
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

  // Get confidence BEFORE tracking (tracking increments count)
  const confidence = getConfidence(best, name);

  // Track for duplicate detection across companies
  if (best) trackEmail(best);

  if (best) {
    console.log(' -> ' + best + ' [' + foundLayer + '] [' + confidence + '] ' + (result.success ? 'OK' : 'FAIL'));
  } else {
    console.log(' -> NOT FOUND');
  }

  // 3 second delay between companies
  await new Promise(r => setTimeout(r, 3000));
  return { company: name, email: best, status: status, layer: foundLayer, confidence: confidence };
}

// ─── Main ────────────────────────────────────────────────────
async function run() {
  console.log('=== EmailHunter Test Run (5-Layer) ===');
  console.log('Layers: Search -> Contact Page -> Facebook -> Retry Query -> Filter\n');
  let count = 0, found = 0;
  const layers = {};
  const confidences = { HIGH: 0, MED: 0, LOW: 0 };
  while (true) {
    const r = await processOne();
    if (!r) break;
    count++;
    if (r.email) {
      found++;
      layers[r.layer] = (layers[r.layer] || 0) + 1;
      if (r.confidence && confidences[r.confidence] !== undefined) {
        confidences[r.confidence]++;
      }
    }
  }
  const pct = count > 0 ? Math.round(found / count * 100) : 0;
  console.log('\n=== Results ===');
  console.log('Total: ' + count + ' | Found: ' + found + ' (' + pct + '%)');
  console.log('By layer:');
  for (const [k, v] of Object.entries(layers)) {
    console.log('  ' + k + ': ' + v);
  }
  console.log('By confidence:');
  for (const [k, v] of Object.entries(confidences)) {
    if (v > 0) console.log('  ' + k + ': ' + v);
  }
}

run().catch(e => console.error('FATAL:', e.message));
