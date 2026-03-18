const http = require('http');
const https = require('https');
const API = 'http://emailhunter-api:3456';
const SRX = 'http://emailhunter-searxng:8080';

function get(url) { return new Promise((ok,no) => { http.get(url, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ok(JSON.parse(d))}catch(e){ok({raw:d})} }); }).on('error',no); }); }
function post(url, body) { return new Promise((ok,no) => { const data = JSON.stringify(body); const req = http.request(url, {method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}}, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{ try{ok(JSON.parse(d))}catch(e){ok({raw:d})} }); }); req.on('error',no); req.write(data); req.end(); }); }
function fetchPage(url, timeout) { return new Promise(ok => { const timer = setTimeout(() => ok(''), timeout||8000); try { const mod = url.startsWith('https') ? https : http; mod.get(url, {timeout:timeout||8000, headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'}}, res => { if(res.statusCode>=300&&res.statusCode<400&&res.headers.location){clearTimeout(timer);return fetchPage(res.headers.location,timeout).then(ok);} let d=''; res.on('data',c=>{d+=c;if(d.length>500000)res.destroy();}); res.on('end',()=>{clearTimeout(timer);ok(d);}); res.on('error',()=>{clearTimeout(timer);ok('');}); }).on('error',()=>{clearTimeout(timer);ok('');}); } catch(e){clearTimeout(timer);ok('');} }); }

const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
const JUNK = ['noreply@','no-reply@','example@','test@','webmaster@','postmaster@'];
const BAD_DOMAINS = ['facebook.com','google.com','wikipedia.org','jobthai.com','jobsdb.com','linkedin.com','pantip.com','sentry.io','wixpress.com'];

function cleanEmails(text) {
  const raw = [...new Set((text.match(EMAIL_RE)||[]))];
  return raw.filter(e => {
    const l = e.toLowerCase();
    if (JUNK.some(j => l.startsWith(j))) return false;
    const domain = l.split('@')[1]||'';
    if (BAD_DOMAINS.some(b => domain===b||domain.endsWith('.'+b))) return false;
    if (domain.endsWith('.go.th')||domain.endsWith('.ac.th')) return false;
    if (domain.endsWith('.png')||domain.endsWith('.jpg')) return false;
    return true;
  });
}

function findContactUrls(html, baseUrl) {
  const urls = [];
  const re = /href=["']([^"']*(?:contact|about|ติดต่อ|เกี่ยวกับ)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let url = m[1];
    if (url.startsWith('/')) { try { url = new URL(url, baseUrl).href; } catch(e) { continue; } }
    if (url.startsWith('http') && urls.length < 3) urls.push(url);
  }
  return urls;
}

async function processOne() {
  const data = await get(API+'/api/companies/next?force=true');
  if (!data.company) return null;
  const id = data.company.id;
  const name = data.company.company_name;
  const query = data.search.query;
  const engines = data.search.engines;
  process.stdout.write('['+id+'] '+name);

  // Layer 1: SearXNG Search
  const sr = await get(SRX+'/search?q='+encodeURIComponent(query)+'&format=json&engines='+engines);
  let allText = '';
  const urls = [];
  for (const r of (sr.results||[])) { allText += ' '+(r.title||'')+' '+(r.content||'')+' '+(r.url||''); if(r.url&&urls.length<5) urls.push(r.url); }
  let emails = cleanEmails(allText);
  let sourceUrl = '';
  let layer = '';

  if (emails.length > 0) {
    layer = 'search';
    for (const r of (sr.results||[])) { if(((r.title||'')+' '+(r.content||'')+' '+(r.url||'')).includes(emails[0])){sourceUrl=r.url||'';break;} }
  }

  // Layer 2: Website crawl
  if (emails.length===0 && urls.length>0) {
    for (const url of urls.slice(0,3)) {
      try {
        const html = await fetchPage(url, 8000);
        if (!html) continue;
        const pe = cleanEmails(html);
        if (pe.length>0) { emails=pe; sourceUrl=url; layer='website'; break; }
        const contactUrls = findContactUrls(html, url);
        for (const cu of contactUrls) {
          const ch = await fetchPage(cu, 6000);
          const ce = cleanEmails(ch||'');
          if (ce.length>0) { emails=ce; sourceUrl=cu; layer='contact'; break; }
        }
        if (emails.length>0) break;
      } catch(e) {}
    }
  }

  // Layer 3: Facebook search
  if (emails.length===0) {
    const fbSr = await get(SRX+'/search?q='+encodeURIComponent('"'+name+'" site:facebook.com email')+'&format=json&engines=google');
    let fbText = '';
    for (const r of (fbSr.results||[])) { fbText += ' '+(r.title||'')+' '+(r.content||'')+' '+(r.url||''); }
    const fbe = cleanEmails(fbText);
    if (fbe.length>0) { emails=fbe; layer='facebook'; for(const r of (fbSr.results||[])){if(((r.title||'')+' '+(r.content||'')).includes(fbe[0])){sourceUrl=r.url||'';break;}} }
  }

  // Save
  const best = emails[0]||null;
  const status = best ? 'found' : 'not_found';
  await post(API+'/api/companies/'+id+'/result', { email:best, all_emails:emails, source_url:sourceUrl, status:status, source:layer||'none' });

  if (best) { console.log(' => '+best+' ['+layer+']'); }
  else { console.log(' => NOT FOUND'); }

  await new Promise(r => setTimeout(r, 3000));
  return { name, email: best, status, layer };
}

async function main() {
  console.log('=== Processing 10 companies ===\n');
  let count=0, found=0;
  const results = [];
  while(true) {
    const r = await processOne();
    if (!r) break;
    count++;
    results.push(r);
    if (r.email) found++;
  }
  console.log('\n=============================');
  console.log('Total: '+count+' | Found: '+found+' | Not Found: '+(count-found));
  console.log('=============================');
  console.log('\nDetails:');
  results.forEach((r,i) => {
    console.log((i+1)+'. '+r.name);
    console.log('   '+(r.email ? 'Email: '+r.email+' ['+r.layer+']' : 'NOT FOUND'));
  });
}
main().catch(e => console.error('FAIL:', e.message));
