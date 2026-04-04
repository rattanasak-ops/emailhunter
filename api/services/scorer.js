// ─────────────────────────────────────────────────────────────
// Email Scoring, Filtering & Validation
// ─────────────────────────────────────────────────────────────

const { db } = require('../config/database');
const {
  BLACKLIST_DOMAINS, GENERIC_PROVIDERS, ALLOWED_SHORT_LOCAL,
  FOREIGN_TLDS, THAI_COMPANY_SUFFIXES,
} = require('../config/constants');

// ─── Prepared Statements for email_assignments ───────────────
const _getAssignCount = db.prepare('SELECT assign_count FROM email_assignments WHERE email = ?');
const _upsertAssign = db.prepare(`
  INSERT INTO email_assignments (email, assign_count, last_assigned_to, updated_at)
  VALUES (?, 1, ?, datetime('now','localtime'))
  ON CONFLICT(email) DO UPDATE SET
    assign_count = assign_count + 1,
    last_assigned_to = excluded.last_assigned_to,
    updated_at = datetime('now','localtime')
`);

function getEmailAssignCount(email) {
  const row = _getAssignCount.get(email.toLowerCase());
  return row ? row.assign_count : 0;
}

function trackEmailAssignment(email, companyName) {
  _upsertAssign.run(email.toLowerCase(), companyName || '');
}

// ─── Company Name Utilities ──────────────────────────────────

function normalizeCompanyName(name) {
  return name
    .replace(THAI_COMPANY_SUFFIXES, '')
    .replace(/[\s().,\-\/&]/g, '')
    .toLowerCase();
}

function extractEnglishParts(name) {
  const english = name.match(/[a-zA-Z]{3,}/g) || [];
  return english.map(e => e.toLowerCase());
}

function getCompanyInitials(companyName) {
  return companyName
    .replace(THAI_COMPANY_SUFFIXES, '').trim()
    .split(/\s+/)
    .map(w => w[0] || '')
    .join('')
    .toLowerCase();
}

function isDomainRelatedToCompany(domain, companyName) {
  const domainBase = domain.split('.')[0].toLowerCase();
  if (domainBase.length < 2) return false;

  const cleanName = normalizeCompanyName(companyName);
  const englishParts = extractEnglishParts(companyName);

  if (cleanName.includes(domainBase) || domainBase.includes(cleanName.slice(0, 4))) return true;
  if (englishParts.some(ep => domainBase.includes(ep) || ep.includes(domainBase))) return true;

  const initials = getCompanyInitials(companyName);
  if (initials.length >= 2 && domainBase.includes(initials)) return true;

  return false;
}

// ─── Email Validation ────────────────────────────────────────

// companyName is optional — used for smart foreignTLD check
function isBlacklistedEmail(email, companyName) {
  if (!email) return true;
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split('@');
  if (!domain) return true;

  // Always block: government, academic, Chinese domains
  if (domain.endsWith('.go.th')) return true;
  if (domain.endsWith('.cn')) return true;
  if (domain.endsWith('.ac.th') || domain.endsWith('.edu')) return true;

  // Foreign TLDs — block UNLESS domain matches company name
  if (FOREIGN_TLDS.some(tld => domain.endsWith(tld))) {
    // Smart exception: ถ้า domain เกี่ยวข้องกับชื่อบริษัท → อนุญาต
    if (companyName && isDomainRelatedToCompany(domain, companyName)) {
      // ปล่อยผ่าน — อาจเป็น subsidiary ต่างประเทศ
    } else {
      return true;
    }
  }

  // Junk local parts
  if (localPart.length < 3 && !ALLOWED_SHORT_LOCAL.includes(localPart)) return true;
  if (/^x{3,}$/.test(localPart)) return true;
  if (/^\d{1,3}$/.test(localPart)) return true;
  if (/^(.)\1{4,}$/.test(localPart)) return true; // aaaaaa@, bbbbb@

  const junkLocalParts = [
    'youremail', 'your.email', 'yourname', 'your.name', 'email', 'sample',
    'sampleemail', 'name', 'username', 'user', 'firstname', 'lastname',
    'myemail', 'me', 'someone', 'anybody', 'nobody', 'test', 'demo',
    'null', 'undefined', 'root', 'administrator',
  ];
  if (junkLocalParts.includes(localPart)) return true;

  return BLACKLIST_DOMAINS.some(bl => domain === bl || domain.endsWith('.' + bl));
}

function isGenericProvider(email) {
  const domain = email.toLowerCase().split('@')[1] || '';
  return GENERIC_PROVIDERS.includes(domain);
}

// ─── Email Scoring ───────────────────────────────────────────

function scoreEmail(email, companyName, source = 'search') {
  if (!email) return -1;
  const lower = email.toLowerCase();
  const [localPart, domain] = lower.split('@');
  if (!domain) return -1;

  const assignCount = getEmailAssignCount(lower);
  if (assignCount >= 1) return -10;
  if (isBlacklistedEmail(email, companyName)) return -10;

  const hrPatterns = ['hr', 'recruit', 'hiring', 'career', 'job', 'talent', 'staffing'];
  const isHrEmail = hrPatterns.some(p => localPart.includes(p));
  const isBusinessPrefix = ['info', 'contact', 'sales', 'admin', 'support', 'service', 'acc'].some(p => localPart.startsWith(p));
  const isPersonalEmail = /^[a-z]+\.[a-z]$/.test(localPart) || (/^[a-z]{2,}\.[a-z]{2,}$/.test(localPart) && !isBusinessPrefix);

  const sourceBonus = (source === 'website' || source === 'contact-page') ? 15 :
                      (source === 'mx-guess') ? 5 : 0;

  // Tier A: Company-domain match
  if (isDomainRelatedToCompany(domain, companyName)) {
    if (isHrEmail) return 55 + sourceBonus;
    if (isPersonalEmail) return 75 + sourceBonus;
    if (isBusinessPrefix) return 120 + sourceBonus;
    return 100 + sourceBonus;
  }

  // Tier B: .co.th domain
  if (domain.endsWith('.co.th')) {
    if (isHrEmail) return 25 + sourceBonus;
    if (isBusinessPrefix) return 55 + sourceBonus;
    if (isPersonalEmail) return 35 + sourceBonus;
    return 45 + sourceBonus;
  }

  // Tier C: Other Thai TLDs
  if (domain.endsWith('.in.th') || domain.endsWith('.or.th')) {
    if (isBusinessPrefix) return 45 + sourceBonus;
    return 35 + sourceBonus;
  }

  // Tier D: Generic providers (gmail, hotmail)
  // SME ไทยใช้ gmail เยอะ → ให้ผ่านถ้ามี company ref
  if (isGenericProvider(email)) {
    if (isHrEmail) return 10;
    const englishParts = extractEnglishParts(companyName);
    const hasCompanyRef = englishParts.some(ep => ep.length >= 3 && localPart.includes(ep));
    if (hasCompanyRef && isBusinessPrefix) return 50 + sourceBonus; // thaioil.info@gmail → ดี
    if (hasCompanyRef) return 40 + sourceBonus;                     // thaioil@gmail → OK
    if (isBusinessPrefix) return 30 + sourceBonus;                  // info@gmail → พอได้
    return 18;                                                      // random@gmail → ไม่ผ่าน
  }

  // Tier E: .com/.net/.org without company match
  if (domain.endsWith('.com') || domain.endsWith('.net') || domain.endsWith('.org')) {
    if (isBusinessPrefix) return 35 + sourceBonus;
    if (isPersonalEmail) return 20;
    return 25 + sourceBonus;
  }

  return 18;
}

// ─── Filter & Rank ───────────────────────────────────────────

// MIN_SCORE แยกตาม source — email จาก website น่าเชื่อถือกว่า search snippet
function getMinScore(source) {
  if (source === 'website' || source === 'contact-page') return 20;  // เจอบนเว็บบริษัท → เชื่อถือได้
  if (source === 'mx-guess') return 30;                               // guess → ต้องมั่นใจหน่อย
  return 25;                                                          // search snippet → กลาง
}

function filterValidEmails(emails, companyName, source = 'search') {
  if (!emails) return { best: null, all: [], confidence: 'none' };
  const list = Array.isArray(emails) ? emails : [emails];
  const minScore = getMinScore(source);

  const scored = list
    .filter(e => e && typeof e === 'string')
    .map(e => ({ email: e, score: scoreEmail(e, companyName, source) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { best: null, all: [], confidence: 'none' };

  const best = scored[0].email;
  const confidence = scored[0].score >= 100 ? 'high' : scored[0].score >= 50 ? 'medium' : 'low';

  trackEmailAssignment(best, companyName);

  return {
    best,
    all: scored.map(x => x.email),
    confidence,
  };
}

module.exports = {
  scoreEmail,
  filterValidEmails,
  isBlacklistedEmail,
  isGenericProvider,
  normalizeCompanyName,
  extractEnglishParts,
  getCompanyInitials,
  isDomainRelatedToCompany,
  getEmailAssignCount,
  trackEmailAssignment,
};
