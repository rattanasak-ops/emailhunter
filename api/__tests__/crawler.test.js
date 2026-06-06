// ─────────────────────────────────────────────────────────────
// Tests for crawler extraction and search result ranking
// ─────────────────────────────────────────────────────────────

jest.mock('../config/database', () => ({
  db: {
    prepare: () => ({ get: () => null, run: () => ({}) }),
  },
  log: () => {},
}));

const {
  extractEmailsFromHtml,
  extractEmailCandidates,
  rankSearchResults,
  classifyResultHost,
  decodeCloudflareEmail,
  extractContactLinks,
} = require('../services/crawler');

describe('email extraction', () => {
  test('does not include trailing words after a valid TLD', () => {
    const emails = extractEmailsFromHtml('Contact support@jobthai.comAdvertising for details');
    expect(emails).toEqual(['support@jobthai.com']);
  });

  test('normalizes www subdomain in email domain', () => {
    const emails = extractEmailsFromHtml('Email: info@www.mesa-th.com');
    expect(emails).toEqual(['info@mesa-th.com']);
  });

  test('extracts at-dot obfuscated emails', () => {
    const emails = extractEmailsFromHtml('Sales: info at acme dot co.th');
    expect(emails).toEqual(['info@acme.co.th']);
  });

  test('decodes Cloudflare protected emails', () => {
    expect(decodeCloudflareEmail('6f060109002f0a170e021f030a410c0002')).toBe('info@example.com');
  });
});

describe('search result classification', () => {
  test('classifies news, job, directory, social, and candidate hosts', () => {
    expect(classifyResultHost('https://www.khaosod.co.th/business')).toBe('news');
    expect(classifyResultHost('https://www.jobthai.com/th/company/1')).toBe('job');
    expect(classifyResultHost('https://www.dataforthai.com/company/1')).toBe('directory');
    expect(classifyResultHost('https://www.facebook.com/example')).toBe('social');
    expect(classifyResultHost('https://www.siamcement.co.th/contact')).toBe('candidate');
  });

  test('ranks official-looking company domains above news and job cache results', () => {
    const results = [
      { title: 'News', url: 'https://www.khaosod.co.th/business/siam-cement', content: 'info@news.co.th' },
      { title: 'Job', url: 'https://www.jobthai.com/th/company/1', content: 'hr@jobthai.com' },
      { title: 'Contact', url: 'https://www.siamcement.co.th/contact-us', content: 'info@siamcement.co.th' },
    ];

    const ranked = rankSearchResults(results, 'Siam Cement');
    expect(ranked[0].url).toBe('https://www.siamcement.co.th/contact-us');
  });

  test('email candidates preserve the source URL that actually contained the email', () => {
    const results = [
      { title: 'Directory', url: 'https://www.dataforthai.com/company/1', content: 'No email' },
      { title: 'Contact', url: 'https://www.siamcement.co.th/contact-us', content: 'info@siamcement.co.th' },
    ];

    const candidates = extractEmailCandidates(results, 'Siam Cement');
    expect(candidates[0].email).toBe('info@siamcement.co.th');
    expect(candidates[0].sourceUrl).toBe('https://www.siamcement.co.th/contact-us');
  });

  test('extracts same-host contact-like links from HTML', () => {
    const html = [
      '<a href="/contact-us">Contact</a>',
      '<a href="https://external.example/contact">External</a>',
      '<a href="/products">Products</a>',
      '<a href="/th/ติดต่อเรา">ติดต่อเรา</a>',
    ].join('');

    expect(extractContactLinks(html, 'https://www.example.co.th/')).toEqual([
      'https://www.example.co.th/contact-us',
      'https://www.example.co.th/th/%E0%B8%95%E0%B8%B4%E0%B8%94%E0%B8%95%E0%B9%88%E0%B8%AD%E0%B9%80%E0%B8%A3%E0%B8%B2',
    ]);
  });
});
