// ─────────────────────────────────────────────────────────────
// Constants & Configuration
// ─────────────────────────────────────────────────────────────

const path = require('path');

// ─── Query Patterns — weighted patterns across 6 tiers ──────
const QUERY_PATTERNS = [
  // Tier 1: Core Thai patterns (highest historical success)
  { pattern: '"{company}" email ติดต่อ', weight: 10, tier: 1 },
  { pattern: '"{company}" อีเมล', weight: 8, tier: 1 },
  { pattern: '"{company}" contact email', weight: 9, tier: 1 },
  { pattern: '{company} email address', weight: 7, tier: 1 },
  { pattern: '"{company}" อีเมล์ ติดต่อเรา', weight: 7, tier: 1 },
  { pattern: '{company} contact us email address', weight: 6, tier: 1 },
  { pattern: '"{company}" ติดต่อเรา @', weight: 6, tier: 1 },
  { pattern: '{company} info@ OR contact@ OR sales@', weight: 8, tier: 1 },
  // Tier 2: Thai company-specific
  { pattern: '{company} site:*.co.th email', weight: 5, tier: 2 },
  { pattern: '"ติดต่อ {company}" email', weight: 5, tier: 2 },
  { pattern: '{company} อีเมล ติดต่อ สอบถาม', weight: 4, tier: 2 },
  { pattern: '{company} email @', weight: 4, tier: 2 },
  { pattern: '"{company}" .co.th email', weight: 5, tier: 2 },
  { pattern: '"{company}" ฝ่ายขาย อีเมล', weight: 4, tier: 2 },
  { pattern: '"{company}" แผนกขาย ติดต่อ email', weight: 3, tier: 2 },
  { pattern: '"{company}" สำนักงานใหญ่ อีเมล', weight: 4, tier: 2 },
  { pattern: '"{company}" เว็บไซต์ ติดต่อ', weight: 4, tier: 2 },
  { pattern: '"{company}" official website contact', weight: 4, tier: 2 },
  // Tier 3: English-first patterns (international companies in TH)
  { pattern: '"{company}" Thailand email contact', weight: 5, tier: 3 },
  { pattern: '"{company}" Bangkok email', weight: 4, tier: 3 },
  { pattern: '"{company}" Thailand office email', weight: 4, tier: 3 },
  { pattern: '"{company}" company email Thailand', weight: 3, tier: 3 },
  { pattern: '"{company}" email site:*.com', weight: 3, tier: 3 },
  // Tier 4: Industry-specific
  { pattern: '"{company}" manufacturing email contact', weight: 3, tier: 4 },
  { pattern: '"{company}" export import email Thailand', weight: 3, tier: 4 },
  { pattern: '"{company}" trading company email', weight: 3, tier: 4 },
  { pattern: '"{company}" construction company email ติดต่อ', weight: 3, tier: 4 },
  { pattern: '"{company}" hotel resort email reservation', weight: 2, tier: 4 },
  { pattern: '"{company}" logistics transport email', weight: 2, tier: 4 },
  // Tier 5: Directory & registry site-specific
  { pattern: 'site:dataforthai.com "{company}"', weight: 4, tier: 5 },
  { pattern: 'site:yellowpages.co.th "{company}"', weight: 3, tier: 5 },
  { pattern: '"{company}" site:dbd.go.th', weight: 3, tier: 5 },
  { pattern: '"{company}" กรมพัฒนาธุรกิจ email', weight: 3, tier: 5 },
  // Tier 6: Social media profiles
  { pattern: 'site:facebook.com "{company}" email', weight: 3, tier: 6 },
  { pattern: '"{company}" facebook email ติดต่อ', weight: 3, tier: 6 },
  { pattern: '"{company}" linkedin company email', weight: 2, tier: 6 },
];

// ─── Engine Configuration ────────────────────────────────────
const ALL_ENGINES = ['google', 'bing', 'duckduckgo', 'startpage', 'brave', 'yahoo', 'qwant', 'mojeek'];

const ENGINE_TIERS = {
  primary: ['google', 'bing', 'brave'],
  secondary: ['duckduckgo', 'startpage', 'yahoo'],
  tertiary: ['qwant', 'mojeek'],
};

const ENGINE_COOLDOWN_MS = 120000; // 2 minutes between uses of same engine

// ─── Anti-Blocking Thresholds ────────────────────────────────
const ALL_DOWN_ALERT_INTERVAL = 15 * 60 * 1000; // 15 min between alerts
const ALL_DOWN_BACKOFF_STEPS = [60, 120, 300, 600, 900]; // 1m→2m→5m→10m→15m
const ERROR_BUFFER_SIZE = 20;
const RAMP_UP_QUERIES = 10;
const RAMP_UP_MULTIPLIER = 2.0;

// ─── Rejection Reason Constants ──────────────────────────────
const REJECTION_REASONS = {
  SEARCH_NO_RESULTS: 'search_no_results',
  SEARCH_NO_EMAILS: 'search_no_emails',
  CRAWL_NO_EMAILS: 'crawl_no_emails',
  ALL_FILTERED: 'all_filtered',
  ENGINE_BLOCKED: 'engine_blocked',
  TIMEOUT: 'timeout',
};

// ─── Blacklisted Domains (loaded from config/blacklist.json) ─
const blacklistData = require(path.join(__dirname, 'blacklist.json'));
const BLACKLIST_DOMAINS = Object.entries(blacklistData)
  .filter(([key]) => key !== '_comment')
  .flatMap(([, domains]) => domains);

// ─── Generic Email Providers (OK for Thai SMEs) ─────────────
const GENERIC_PROVIDERS = [
  'gmail.com', 'hotmail.com', 'yahoo.com', 'outlook.com', 'live.com',
  'hotmail.co.th', 'yahoo.co.th', 'icloud.com', 'me.com',
  'protonmail.com', 'mail.com', 'gmx.com',
];

const ALLOWED_SHORT_LOCAL = ['info', 'sales', 'contact', 'sale', 'hr', 'admin', 'acc', 'fax'];

// ─── Foreign TLDs to block (unless domain matches company) ──
const FOREIGN_TLDS = [
  '.se', '.de', '.fr', '.ru', '.kr', '.jp', '.tw', '.br', '.mx', '.nz',
  '.ma', '.au', '.uk', '.it', '.es', '.nl', '.pl', '.cz', '.at', '.ch',
  '.dk', '.fi', '.no', '.pt', '.ie', '.za', '.ar', '.cl', '.co', '.pe',
  '.vn', '.id', '.ph',
];
// หมายเหตุ: ลบ .sg, .my, .hk, .in ออก เพราะบริษัทไทยที่เป็น subsidiary อาจใช้ domain เหล่านี้

const THAI_COMPANY_SUFFIXES = /บริษัท|จำกัด|มหาชน|\(ประเทศไทย\)|ห้างหุ้นส่วน|สามัญ|จำกัด\s*\(มหาชน\)/g;

const EMAIL_PREFIXES = ['info', 'contact', 'sales', 'admin', 'service', 'support'];

// ─── Contact Page Paths (เรียงตามความน่าจะเจอ email มากสุดก่อน) ─
const CONTACT_PATHS = [
  // Thai paths (บริษัทไทยมักมี)
  '/contact', '/contact-us', '/contactus',
  '/th/contact', '/th/contact-us', '/th/contactus',
  // Thai language paths
  '/ติดต่อเรา', '/th/ติดต่อเรา', '/ติดต่อ',
  // English variants
  '/en/contact', '/en/contact-us',
  '/about', '/about-us', '/aboutus',
  '/th/about', '/th/about-us',
  // HTML extensions
  '/contact.html', '/contact.php', '/about.html',
  // Company info pages
  '/company', '/company-profile',
  // Footer/sitemap often has email
  '/footer', '/sitemap',
];

// ─── Skip Domains for Crawling ───────────────────────────────
const CRAWL_SKIP_DOMAINS = [
  'facebook.com', 'youtube.com', 'twitter.com', 'instagram.com', 'tiktok.com', 'wikipedia.org',
  'pantip.com', 'sanook.com', 'kapook.com', 'google.com', 'linkedin.com', 'pinterest.com',
  'jobthai.com', 'jobsdb.com', 'indeed.com', 'amazon.com', 'lazada.co.th', 'shopee.co.th',
  'dataforthai.com', 'dbd.go.th', 'thaibizindex.com', 'sixtygram.com', 'longdo.com',
  'apple.com', 'netflix.com', 'microsoft.com', 'reddit.com', 'zhihu.com', 'thairath.co.th',
  'mergepdfs.net', 'oned.net', 'nesn.com', 'pestindex.com', 'thai-language.com',
  'mgronline.com', 'dailynews.co.th', 'matichon.co.th', 'posttoday.com', 'prachachat.net',
  'bangkokpost.com', 'nationtv.tv', 'pptvhd36.com', 'khaosod.co.th', 'springnews.co.th',
  'line.me', 'play.google.com', 'apps.apple.com', 'github.com', 'stackoverflow.com',
  'trustpilot.com', 'glassdoor.com', 'medium.com', 'quora.com', 'yellowpages.co.th',
];

// ─── Allowed TLDs for Crawling ───────────────────────────────
const ALLOWED_TLDS = ['.co.th', '.in.th', '.or.th'];
const EXTENDED_TLDS = ['.com', '.net', '.org'];

// ─── User-Agent Rotation Pool ────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
];

// ─── File Upload ─────────────────────────────────────────────
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

module.exports = {
  QUERY_PATTERNS,
  ALL_ENGINES,
  ENGINE_TIERS,
  ENGINE_COOLDOWN_MS,
  ALL_DOWN_ALERT_INTERVAL,
  ALL_DOWN_BACKOFF_STEPS,
  ERROR_BUFFER_SIZE,
  RAMP_UP_QUERIES,
  RAMP_UP_MULTIPLIER,
  REJECTION_REASONS,
  BLACKLIST_DOMAINS,
  GENERIC_PROVIDERS,
  ALLOWED_SHORT_LOCAL,
  FOREIGN_TLDS,
  THAI_COMPANY_SUFFIXES,
  EMAIL_PREFIXES,
  CONTACT_PATHS,
  CRAWL_SKIP_DOMAINS,
  ALLOWED_TLDS,
  EXTENDED_TLDS,
  USER_AGENTS,
  ALLOWED_EXTENSIONS,
};
