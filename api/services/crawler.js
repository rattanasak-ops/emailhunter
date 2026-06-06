// ─────────────────────────────────────────────────────────────
// Web Crawler — Page fetching + Email extraction
// ─────────────────────────────────────────────────────────────

const https = require('https');
const http = require('http');
const dns = require('dns');
const { promisify } = require('util');
const resolveMx = promisify(dns.resolveMx);

const { log } = require('../config/database');
const {
  USER_AGENTS, CRAWL_SKIP_DOMAINS, CONTACT_PATHS,
  ALLOWED_TLDS, EXTENDED_TLDS, EMAIL_PREFIXES,
  THAI_COMPANY_SUFFIXES, SEARCH_RESULT_NOISE_DOMAINS,
  NEWS_DOMAINS, JOB_BOARD_DOMAINS, DIRECTORY_DOMAINS, SOCIAL_DOMAINS,
} = require('../config/constants');
const { extractEnglishParts, isDomainRelatedToCompany } = require('./scorer');

// ─── User-Agent Rotation ─────────────────────────────────────
let uaIndex = 0;
function pickUserAgent() {
  const ua = USER_AGENTS[uaIndex % USER_AGENTS.length];
  uaIndex++;
  return ua;
}

// ─── Email Extraction from text ──────────────────────────────
const EMAIL_REGEX = /(?:^|[^\w.+%-])([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24})(?![a-zA-Z0-9.-])/g;

function decodeBasicHtmlEntities(text) {
  if (!text) return '';
  return String(text)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&commat;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&dot;/gi, '.')
    .replace(/&amp;/gi, '&');
}

function normalizeEmail(email) {
  if (!email) return '';
  const clean = email.toLowerCase().replace(/^mailto:/, '').replace(/[<>"'()[\]{},;:]+$/g, '');
  const [local, rawDomain] = clean.split('@');
  let domain = rawDomain;
  if (!local || !domain) return '';
  const labels = domain.split('.');
  const last = labels[labels.length - 1] || '';
  const commonTlds = ['co.th', 'co.uk', 'com', 'net', 'org', 'biz', 'info', 'th', 'co', 'ac', 'go', 'or', 'in'];
  const trimmedTld = commonTlds.includes(last) ? null : commonTlds.find(tld => last.startsWith(tld) && last.length > tld.length);
  if (trimmedTld) {
    labels[labels.length - 1] = trimmedTld;
    domain = labels.join('.');
  }
  return `${local}@${domain.replace(/^www\./, '')}`;
}

function collectEmailsFromText(text) {
  const emails = new Set();
  if (!text) return [];
  text = decodeBasicHtmlEntities(text);
  let match;
  EMAIL_REGEX.lastIndex = 0;
  while ((match = EMAIL_REGEX.exec(text)) !== null) {
    const email = normalizeEmail(match[1] || match[0]);
    if (email) emails.add(email);
  }
  return [...emails];
}

function decodeCloudflareEmail(hex) {
  if (!hex || hex.length < 4) return '';
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let decoded = '';
    for (let i = 2; i < hex.length; i += 2) {
      decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return normalizeEmail(decoded);
  } catch {
    return '';
  }
}

function hostMatches(host, domains) {
  return domains.some(d => host === d || host.endsWith('.' + d));
}

function getHost(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

function classifyResultHost(url) {
  const host = getHost(url);
  if (!host) return 'invalid';
  if (hostMatches(host, NEWS_DOMAINS)) return 'news';
  if (hostMatches(host, JOB_BOARD_DOMAINS)) return 'job';
  if (hostMatches(host, DIRECTORY_DOMAINS)) return 'directory';
  if (hostMatches(host, SOCIAL_DOMAINS)) return 'social';
  if (hostMatches(host, SEARCH_RESULT_NOISE_DOMAINS)) return 'noise';
  return 'candidate';
}

function scoreResultUrl(url, companyName, index = 0) {
  const host = getHost(url);
  if (!host) return -999;
  let score = 100 - Math.min(index, 20);
  const type = classifyResultHost(url);
  const lowerUrl = String(url || '').toLowerCase();

  if (ALLOWED_TLDS.some(tld => host.endsWith(tld))) score += 60;
  if (EXTENDED_TLDS.some(tld => host.endsWith(tld))) score += 20;
  if (isDomainRelatedToCompany(host, companyName)) score += 80;
  if (/\/(contact|contact-us|contactus|about|about-us|company|profile|ติดต่อ)/i.test(lowerUrl)) score += 35;
  if (/\.(pdf|csv|xls|xlsx|doc|docx)(?:$|[?#])/i.test(lowerUrl)) score -= 60;

  if (type === 'news') score -= 120;
  else if (type === 'job') score -= 95;
  else if (type === 'directory') score -= 55;
  else if (type === 'social') score -= 35;
  else if (type === 'noise') score -= 75;

  return score;
}

function rankSearchResults(results, companyName) {
  return (results || [])
    .filter(r => r && r.url)
    .map((r, index) => ({
      ...r,
      _sourceType: classifyResultHost(r.url),
      _rankScore: scoreResultUrl(r.url, companyName, index),
    }))
    .sort((a, b) => b._rankScore - a._rankScore);
}

function extractEmailCandidates(results, companyName) {
  const candidates = [];
  const seen = new Set();
  const ranked = rankSearchResults(results, companyName);

  for (const r of ranked) {
    const text = [r.title, r.content, r.url].filter(Boolean).join(' ');
    for (const email of collectEmailsFromText(text)) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        email,
        sourceUrl: r.url || '',
        sourceType: r._sourceType || classifyResultHost(r.url),
        rankScore: r._rankScore || 0,
      });
    }
  }

  return candidates.sort((a, b) => b.rankScore - a.rankScore);
}

function extractEmails(results) {
  const emails = new Set();
  for (const r of (results || [])) {
    const text = [r.title, r.content, r.url].filter(Boolean).join(' ');
    const found = collectEmailsFromText(text);
    found.forEach(e => emails.add(e));
  }
  return [...emails];
}

function extractEmailsFromHtml(html) {
  if (!html) return [];
  const allFound = new Set();
  const decodedHtml = decodeBasicHtmlEntities(html);

  // 1. Standard regex
  collectEmailsFromText(decodedHtml).forEach(e => allFound.add(e));

  // 2. mailto: links — มักมี email ที่ regex พลาด
  const mailtoRegex = /mailto:([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/gi;
  let match;
  while ((match = mailtoRegex.exec(html)) !== null) {
    const email = normalizeEmail(match[1]);
    if (email) allFound.add(email);
  }

  // 3. Obfuscated emails: [at] (at) {at} แทน @
  const obfuscatedRegex = /([a-zA-Z0-9._%+-]+)\s*[\[\(\{]\s*(?:at|AT)\s*[\]\)\}]\s*([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  while ((match = obfuscatedRegex.exec(html)) !== null) {
    const email = normalizeEmail(`${match[1]}@${match[2]}`);
    if (email) allFound.add(email);
  }

  // 4. Text obfuscation: name at domain dot com
  const normalizedObfuscation = decodedHtml
    .replace(/\s+(?:at|\[at\]|\(at\))\s+/gi, '@')
    .replace(/\s+(?:dot|\[dot\]|\(dot\))\s+/gi, '.');
  collectEmailsFromText(normalizedObfuscation).forEach(e => allFound.add(e));

  // 5. Cloudflare email protection
  const cfRegex = /data-cfemail=["']([a-f0-9]+)["']/gi;
  while ((match = cfRegex.exec(decodedHtml)) !== null) {
    const email = decodeCloudflareEmail(match[1]);
    if (email) allFound.add(email);
  }

  // Filter junk
  const junkPrefixes = ['noreply', 'no-reply', 'example', 'test', 'user', 'webmaster', 'postmaster', 'mailer-daemon', 'abuse', 'spam'];
  const junkDomains = ['sentry.', 'wixpress.', 'placeholder.', 'example.', 'test.'];
  const junkExts = ['.png', '.jpg', '.gif', '.svg', '.webp', '.css', '.js'];
  return [...allFound].filter(e => {
    const [local, domain] = e.split('@');
    if (!domain) return false;
    if (junkPrefixes.some(p => local.startsWith(p))) return false;
    if (junkDomains.some(d => domain.includes(d))) return false;
    if (junkExts.some(ext => e.endsWith(ext))) return false;
    return true;
  });
}

function extractContactLinks(html, baseUrl) {
  if (!html || !baseUrl) return [];
  const links = [];
  const seen = new Set();
  const linkRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  const contactWords = /(contact|contact-us|contactus|ติดต่อ|ติดต่อเรา|about|about-us|company|enquiry|inquiry|support|location|branches)/i;
  let match;

  while ((match = linkRegex.exec(html)) !== null) {
    const href = decodeBasicHtmlEntities(match[1] || '').trim();
    const label = (match[2] || '').replace(/<[^>]+>/g, ' ');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) continue;
    if (!contactWords.test(href) && !contactWords.test(label)) continue;

    try {
      const url = new URL(href, baseUrl);
      const base = new URL(baseUrl);
      if (url.hostname !== base.hostname) continue;
      const finalUrl = url.href.split('#')[0];
      if (!seen.has(finalUrl)) {
        seen.add(finalUrl);
        links.push(finalUrl);
      }
    } catch { /* skip */ }
  }

  return links.slice(0, 8);
}

// ─── Page Fetcher ────────────────────────────────────────────

function looksBlocked(html) {
  if (!html) return false;
  const text = html.slice(0, 5000).toLowerCase();
  return text.includes('captcha') ||
    text.includes('too many requests') ||
    text.includes('access denied') ||
    text.includes('unusual traffic') ||
    text.includes('verify you are human');
}

function fetchPage(pageUrl, timeoutMs = 10000, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) {
      log(`Crawler: redirect limit exceeded — ${pageUrl}`);
      return resolve('');
    }
    const mod = pageUrl.startsWith('https') ? https : http;
    const options = { timeout: timeoutMs, headers: { 'User-Agent': pickUserAgent() } };
    mod.get(pageUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        try {
          const nextUrl = new URL(res.headers.location, pageUrl).href;
          return fetchPage(nextUrl, timeoutMs, redirectCount + 1).then(resolve).catch(reject);
        } catch {
          return resolve('');
        }
      }
      if (res.statusCode === 403 || res.statusCode === 429) {
        log(`Crawler: blocked ${res.statusCode} — ${pageUrl}`);
        res.resume();
        return resolve('');
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return resolve('');
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 500000) { res.destroy(); resolve(data); }
      });
      res.on('end', () => {
        if (looksBlocked(data)) {
          log(`Crawler: block page detected — ${pageUrl}`);
          return resolve('');
        }
        resolve(data);
      });
      res.on('error', () => resolve(''));
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

// ─── Smart Contact Page Crawl ────────────────────────────────

async function crawlForEmails(searchResults, companyName, retryCount = 0) {
  const englishParts = extractEnglishParts(companyName);
  let failureReason = 'crawl_no_candidates';

  const rankedResults = rankSearchResults(searchResults, companyName);

  const candidateUrls = rankedResults
    .map(r => r.url)
    .filter(u => {
      if (!u || (!u.startsWith('http://') && !u.startsWith('https://'))) return false;
      try {
        const host = new URL(u).hostname.toLowerCase();
        return !CRAWL_SKIP_DOMAINS.some(d => host === d || host.endsWith('.' + d));
      } catch { return false; }
    });

  const sortedUrls = candidateUrls.filter(u => {
    try {
      const host = new URL(u).hostname.toLowerCase();
      if (ALLOWED_TLDS.some(tld => host.endsWith(tld))) return true;
      if (EXTENDED_TLDS.some(tld => host.endsWith(tld))) {
        const domainName = host.replace(/^www\./, '').split('.')[0];
        if (englishParts.some(ep => ep.length >= 3 && (domainName.includes(ep) || ep.includes(domainName)))) return true;
        if (isDomainRelatedToCompany(host, companyName)) return true;
        const initials = companyName.replace(THAI_COMPANY_SUFFIXES, '').trim()
          .split(/\s+/).map(w => (w.match(/^[a-zA-Z]/) || [''])[0]).filter(Boolean).join('').toLowerCase();
        if (initials.length >= 2 && domainName.includes(initials)) return true;
      }
      return false;
    } catch { return false; }
  });

  const triedDomains = new Set();
  const requestBudgetByHost = new Map();
  const crawlLimit = retryCount >= 1 ? 5 : 3;

  function canSpend(host) {
    const used = requestBudgetByHost.get(host) || 0;
    const limit = retryCount >= 1 ? 6 : 4;
    if (used >= limit) return false;
    requestBudgetByHost.set(host, used + 1);
    return true;
  }

  for (const pageUrl of sortedUrls.slice(0, crawlLimit)) {
    try {
      const initialHost = new URL(pageUrl).hostname;
      if (!canSpend(initialHost)) continue;
      const html = await fetchPage(pageUrl);
      if (!html) failureReason = 'crawl_fetch_empty';
      const pageEmails = extractEmailsFromHtml(html);
      if (pageEmails.length > 0) {
        log(`Crawler: found ${pageEmails.length} emails from ${pageUrl}`);
        return { emails: pageEmails, source: 'website', sourceUrl: pageUrl };
      }
      if (html) failureReason = 'crawl_no_email_on_candidate';

      const urlObj = new URL(pageUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      if (!triedDomains.has(urlObj.hostname)) {
        triedDomains.add(urlObj.hostname);
        const discoveredLinks = extractContactLinks(html, baseUrl);

        // Step 2a: Crawl homepage — email มักอยู่ใน footer
        let homeHtml = '';
        try {
          if (!canSpend(urlObj.hostname)) continue;
          homeHtml = await fetchPage(baseUrl + '/');
          if (homeHtml.length > 1000) {
            const homeEmails = extractEmailsFromHtml(homeHtml);
            if (homeEmails.length > 0) {
              log(`Crawler: found ${homeEmails.length} emails from ${baseUrl}/ (homepage)`);
              return { emails: homeEmails, source: 'website', sourceUrl: baseUrl + '/' };
            }
            discoveredLinks.push(...extractContactLinks(homeHtml, baseUrl));
            failureReason = 'crawl_no_email_on_homepage';
          }
        } catch { /* skip */ }

        // Step 2b: Contact pages and discovered contact-like links
        const fixedContactUrls = CONTACT_PATHS.map(contactPath => baseUrl + contactPath);
        const contactUrls = [...new Set([...discoveredLinks, ...fixedContactUrls])];
        for (const contactUrl of contactUrls) {
          try {
            if (!canSpend(urlObj.hostname)) break;
            const contactHtml = await fetchPage(contactUrl);
            if (contactHtml.length > 1000) {
              const contactEmails = extractEmailsFromHtml(contactHtml);
              if (contactEmails.length > 0) {
                log(`Crawler: found ${contactEmails.length} emails from ${contactUrl}`);
                return { emails: contactEmails, source: 'contact-page', sourceUrl: contactUrl };
              }
              failureReason = 'crawl_no_email_on_contact';
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  return { emails: [], source: 'crawl', reason: failureReason };
}

// ─── Email Pattern Guessing + MX Verification ────────────────

function guessDomainsFromCompany(companyName) {
  const domains = [];
  const english = extractEnglishParts(companyName);

  for (const part of english) {
    if (part.length >= 3) {
      domains.push(`${part}.co.th`);
      domains.push(`${part}.com`);
    }
  }

  // Concatenated: "Siam Cement" → "siamcement.co.th"
  if (english.length >= 2) {
    const concat = english.join('');
    if (concat.length >= 4 && concat.length <= 30) {
      domains.push(`${concat}.co.th`);
      domains.push(`${concat}.com`);
    }
    // Hyphenated: "Thai Oil" → "thai-oil.co.th"
    const hyphen = english.join('-');
    domains.push(`${hyphen}.co.th`);
    domains.push(`${hyphen}.com`);
  }

  // Initials: "Advanced Info Service" → "ais.co.th"
  const words = companyName.replace(THAI_COMPANY_SUFFIXES, '').trim().split(/\s+/).filter(w => w.length > 0);
  const initials = words.map(w => { const m = w.match(/^[a-zA-Z]/); return m ? m[0].toLowerCase() : ''; }).filter(Boolean).join('');
  if (initials.length >= 2 && initials.length <= 6) {
    domains.push(`${initials}.co.th`);
    domains.push(`${initials}.com`);
  }

  // First word only: "Toyota Motor" → "toyota.co.th"
  if (english.length > 0 && english[0].length >= 4) {
    domains.push(`${english[0]}.co.th`);
    domains.push(`${english[0]}.com`);
  }

  return [...new Set(domains)];
}

async function verifyMxRecord(domain) {
  try {
    const records = await resolveMx(domain);
    return records && records.length > 0 ? records : null;
  } catch { return null; }
}

// SMTP RCPT TO verification — ตรวจว่า email มีจริงหรือไม่
const net = require('net');
function verifySmtpEmail(email, mxHost, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const socket = net.createConnection(25, mxHost);
    let step = 0;
    let resolved = false;

    const finish = (result) => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve(result);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(false));
    socket.on('error', () => finish(false));

    socket.on('data', (data) => {
      const response = data.toString();
      if (step === 0 && response.startsWith('220')) {
        socket.write('EHLO emailhunter.local\r\n');
        step = 1;
      } else if (step === 1 && response.startsWith('250')) {
        socket.write(`MAIL FROM:<verify@emailhunter.local>\r\n`);
        step = 2;
      } else if (step === 2 && response.startsWith('250')) {
        socket.write(`RCPT TO:<${email}>\r\n`);
        step = 3;
      } else if (step === 3) {
        // 250 = email exists, 550/551/553 = not exists
        const exists = response.startsWith('250');
        socket.write('QUIT\r\n');
        finish(exists);
      } else {
        finish(false);
      }
    });
  });
}

async function guessEmailByMX(companyName) {
  const candidateDomains = guessDomainsFromCompany(companyName);
  if (candidateDomains.length === 0) return { emails: [], source: 'mx-guess', domain: null };

  for (const domain of candidateDomains.slice(0, 8)) {
    try {
      const mxRecords = await verifyMxRecord(domain);
      if (!mxRecords) continue;

      log(`Crawler: MX verified — ${domain} accepts email`);
      const mxHost = mxRecords.sort((a, b) => a.priority - b.priority)[0].exchange;

      // SMTP verify: ตรวจว่า info@ หรือ contact@ มีจริงไหม
      const verifiedEmails = [];
      for (const prefix of EMAIL_PREFIXES.slice(0, 3)) { // ลองแค่ info, contact, sales
        const testEmail = `${prefix}@${domain}`;
        try {
          const exists = await verifySmtpEmail(testEmail, mxHost);
          if (exists) {
            verifiedEmails.push(testEmail);
            log(`Crawler: SMTP verified — ${testEmail} EXISTS`);
            break; // เจอ 1 ตัวพอ
          }
        } catch { /* skip */ }
      }

      if (verifiedEmails.length > 0) {
        return { emails: verifiedEmails, source: 'smtp-verified', domain };
      }

      // Fallback: ถ้า SMTP verify ไม่ได้ (port 25 blocked) → ใช้ MX guess เดิม
      const emails = EMAIL_PREFIXES.map(prefix => `${prefix}@${domain}`);
      return { emails, source: 'mx-guess', domain };
    } catch { /* skip */ }
  }
  return { emails: [], source: 'mx-guess', domain: null };
}

module.exports = {
  extractEmails,
  extractEmailCandidates,
  extractEmailsFromHtml,
  fetchPage,
  crawlForEmails,
  guessEmailByMX,
  pickUserAgent,
  rankSearchResults,
  classifyResultHost,
  normalizeEmail,
  decodeBasicHtmlEntities,
  decodeCloudflareEmail,
  extractContactLinks,
};
