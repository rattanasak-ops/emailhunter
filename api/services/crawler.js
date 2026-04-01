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
  THAI_COMPANY_SUFFIXES,
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
const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

function extractEmails(results) {
  const emails = new Set();
  for (const r of (results || [])) {
    const text = [r.title, r.content, r.url].filter(Boolean).join(' ');
    const found = text.match(EMAIL_REGEX) || [];
    found.forEach(e => emails.add(e.toLowerCase()));
  }
  return [...emails];
}

function extractEmailsFromHtml(html) {
  if (!html) return [];
  const found = html.match(EMAIL_REGEX) || [];
  const junkPrefixes = ['noreply', 'no-reply', 'example', 'test', 'user', 'webmaster', 'postmaster', 'mailer-daemon', 'abuse', 'spam'];
  const junkDomains = ['sentry.', 'wixpress.', 'placeholder.', 'example.', 'test.'];
  const junkExts = ['.png', '.jpg', '.gif', '.svg', '.webp', '.css', '.js'];
  return [...new Set(found.map(e => e.toLowerCase()))].filter(e => {
    const [local, domain] = e.split('@');
    if (!domain) return false;
    if (junkPrefixes.some(p => local.startsWith(p))) return false;
    if (junkDomains.some(d => domain.includes(d))) return false;
    if (junkExts.some(ext => e.endsWith(ext))) return false;
    return true;
  });
}

// ─── Page Fetcher ────────────────────────────────────────────

function fetchPage(pageUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const mod = pageUrl.startsWith('https') ? https : http;
    const options = { timeout: timeoutMs, headers: { 'User-Agent': pickUserAgent() } };
    mod.get(pageUrl, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchPage(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => {
        data += chunk;
        if (data.length > 500000) { res.destroy(); resolve(data); }
      });
      res.on('end', () => resolve(data));
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}

// ─── Smart Contact Page Crawl ────────────────────────────────

async function crawlForEmails(searchResults, companyName, retryCount = 0) {
  const englishParts = extractEnglishParts(companyName);

  const candidateUrls = (searchResults || [])
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
  const crawlLimit = retryCount >= 1 ? 5 : 3;

  for (const pageUrl of sortedUrls.slice(0, crawlLimit)) {
    try {
      const html = await fetchPage(pageUrl);
      const pageEmails = extractEmailsFromHtml(html);
      if (pageEmails.length > 0) {
        log(`Crawler: found ${pageEmails.length} emails from ${pageUrl}`);
        return { emails: pageEmails, source: 'website' };
      }

      const urlObj = new URL(pageUrl);
      const baseUrl = `${urlObj.protocol}//${urlObj.hostname}`;
      if (!triedDomains.has(urlObj.hostname)) {
        triedDomains.add(urlObj.hostname);
        for (const contactPath of CONTACT_PATHS) {
          try {
            const contactHtml = await fetchPage(baseUrl + contactPath);
            if (contactHtml.length > 1000) {
              const contactEmails = extractEmailsFromHtml(contactHtml);
              if (contactEmails.length > 0) {
                log(`Crawler: found ${contactEmails.length} emails from ${baseUrl + contactPath}`);
                return { emails: contactEmails, source: 'contact-page' };
              }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }
  }

  return { emails: [], source: 'crawl' };
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
  if (english.length >= 2) {
    const concat = english.join('');
    if (concat.length >= 4 && concat.length <= 30) {
      domains.push(`${concat}.co.th`);
      domains.push(`${concat}.com`);
    }
  }
  const words = companyName.replace(THAI_COMPANY_SUFFIXES, '').trim().split(/\s+/).filter(w => w.length > 0);
  const initials = words.map(w => { const m = w.match(/^[a-zA-Z]/); return m ? m[0].toLowerCase() : ''; }).filter(Boolean).join('');
  if (initials.length >= 2 && initials.length <= 6) {
    domains.push(`${initials}.co.th`);
    domains.push(`${initials}.com`);
  }
  return [...new Set(domains)];
}

async function verifyMxRecord(domain) {
  try {
    const records = await resolveMx(domain);
    return records && records.length > 0;
  } catch { return false; }
}

async function guessEmailByMX(companyName) {
  const candidateDomains = guessDomainsFromCompany(companyName);
  if (candidateDomains.length === 0) return { emails: [], source: 'mx-guess', domain: null };

  for (const domain of candidateDomains.slice(0, 8)) {
    try {
      const hasMx = await verifyMxRecord(domain);
      if (hasMx) {
        log(`Crawler: MX verified — ${domain} accepts email`);
        const emails = EMAIL_PREFIXES.map(prefix => `${prefix}@${domain}`);
        return { emails, source: 'mx-guess', domain };
      }
    } catch { /* skip */ }
  }
  return { emails: [], source: 'mx-guess', domain: null };
}

module.exports = {
  extractEmails,
  extractEmailsFromHtml,
  fetchPage,
  crawlForEmails,
  guessEmailByMX,
  pickUserAgent,
};
