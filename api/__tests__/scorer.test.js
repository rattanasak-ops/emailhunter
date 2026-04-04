// ─────────────────────────────────────────────────────────────
// Tests for Email Scorer — core quality logic
// ─────────────────────────────────────────────────────────────
// Note: These tests mock the database to run without SQLite

jest.mock('../config/database', () => ({
  db: {
    prepare: () => ({ get: () => null, run: () => ({}) }),
  },
  log: () => {},
  todayStr: () => '2026-04-01',
  randomBetween: (min, max) => Math.floor((min + max) / 2),
}));

const {
  scoreEmail,
  isBlacklistedEmail,
  isGenericProvider,
  normalizeCompanyName,
  extractEnglishParts,
  isDomainRelatedToCompany,
  filterValidEmails,
} = require('../services/scorer');

describe('normalizeCompanyName', () => {
  test('removes Thai company suffixes', () => {
    expect(normalizeCompanyName('บริษัท ไทยออยล์ จำกัด (มหาชน)')).not.toContain('บริษัท');
    expect(normalizeCompanyName('บริษัท ไทยออยล์ จำกัด (มหาชน)')).not.toContain('จำกัด');
  });

  test('removes special characters', () => {
    expect(normalizeCompanyName('ABC (Thailand) Co.')).toBe('abcthailandco');
  });
});

describe('extractEnglishParts', () => {
  test('extracts English words >= 3 chars', () => {
    expect(extractEnglishParts('บริษัท Siam Cement จำกัด')).toEqual(['siam', 'cement']);
  });

  test('ignores short words', () => {
    expect(extractEnglishParts('AB CD EFG')).toEqual(['efg']);
  });
});

describe('isDomainRelatedToCompany', () => {
  test('matches direct domain', () => {
    expect(isDomainRelatedToCompany('siamcement.co.th', 'Siam Cement')).toBe(true);
  });

  test('matches English part in domain', () => {
    expect(isDomainRelatedToCompany('toyota.co.th', 'บริษัท Toyota Motor จำกัด')).toBe(true);
  });

  test('rejects unrelated domain', () => {
    expect(isDomainRelatedToCompany('facebook.com', 'บริษัท ไทยออยล์')).toBe(false);
  });
});

describe('isBlacklistedEmail', () => {
  test('blocks government emails', () => {
    expect(isBlacklistedEmail('info@mof.go.th')).toBe(true);
  });

  test('blocks Chinese domains', () => {
    expect(isBlacklistedEmail('info@company.cn')).toBe(true);
  });

  test('blocks academic emails', () => {
    expect(isBlacklistedEmail('prof@ku.ac.th')).toBe(true);
  });

  test('blocks blacklisted domains', () => {
    expect(isBlacklistedEmail('hr@jobthai.com')).toBe(true);
    expect(isBlacklistedEmail('info@facebook.com')).toBe(true);
  });

  test('blocks junk local parts', () => {
    expect(isBlacklistedEmail('test@company.co.th')).toBe(true);
    expect(isBlacklistedEmail('youremail@company.com')).toBe(true);
    expect(isBlacklistedEmail('xxxxx@company.com')).toBe(true);
  });

  test('allows valid Thai company emails', () => {
    expect(isBlacklistedEmail('info@thaioil.co.th')).toBe(false);
    expect(isBlacklistedEmail('sales@company.com')).toBe(false);
  });

  test('allows short business prefixes', () => {
    expect(isBlacklistedEmail('hr@company.co.th')).toBe(false);
    expect(isBlacklistedEmail('info@company.co.th')).toBe(false);
  });

  test('smart foreignTLD: blocks if no company match', () => {
    expect(isBlacklistedEmail('info@company.de')).toBe(true);
  });

  test('smart foreignTLD: allows if domain matches company', () => {
    expect(isBlacklistedEmail('info@toyota.de', 'Toyota Motor')).toBe(false);
  });
});

describe('isGenericProvider', () => {
  test('identifies gmail', () => {
    expect(isGenericProvider('john@gmail.com')).toBe(true);
  });

  test('identifies hotmail', () => {
    expect(isGenericProvider('john@hotmail.com')).toBe(true);
  });

  test('does not flag company domain', () => {
    expect(isGenericProvider('info@company.co.th')).toBe(false);
  });
});

describe('scoreEmail', () => {
  test('company-domain business prefix = highest score', () => {
    const score = scoreEmail('info@siam.co.th', 'บริษัท Siam จำกัด');
    expect(score).toBeGreaterThanOrEqual(100);
  });

  test('.co.th business prefix = medium-high score', () => {
    const score = scoreEmail('info@random.co.th', 'บริษัท ไทยออยล์');
    expect(score).toBeGreaterThanOrEqual(50);
  });

  test('random gmail = low score (below MIN_SCORE 25)', () => {
    const score = scoreEmail('random123@gmail.com', 'บริษัท ไทยออยล์');
    expect(score).toBeLessThan(25);
  });

  test('gmail with company ref = acceptable (>= 25)', () => {
    const score = scoreEmail('thaioil.sales@gmail.com', 'Thai Oil Company');
    expect(score).toBeGreaterThanOrEqual(25);
  });

  test('gmail info + company ref = good score', () => {
    const score = scoreEmail('thaioil.info@gmail.com', 'Thai Oil Company');
    expect(score).toBeGreaterThanOrEqual(40);
  });

  test('HR email = penalized', () => {
    const score = scoreEmail('hr@company.co.th', 'Test Company');
    expect(score).toBeLessThanOrEqual(55);
  });

  test('blacklisted = -10', () => {
    const score = scoreEmail('info@jobthai.com', 'Test Company');
    expect(score).toBe(-10);
  });

  test('contact-page source bonus', () => {
    const searchScore = scoreEmail('info@siam.co.th', 'Siam Corp', 'search');
    const pageScore = scoreEmail('info@siam.co.th', 'Siam Corp', 'contact-page');
    expect(pageScore).toBeGreaterThan(searchScore);
  });
});

describe('filterValidEmails', () => {
  test('returns best email from list', () => {
    const result = filterValidEmails(
      ['random@gmail.com', 'info@company.co.th', 'hr@jobsite.com'],
      'Company Test'
    );
    expect(result.best).toBe('info@company.co.th');
    expect(result.confidence).not.toBe('none');
  });

  test('returns none when all emails are junk', () => {
    const result = filterValidEmails(
      ['info@jobthai.com', 'test@example.com'],
      'Test Company'
    );
    expect(result.best).toBeNull();
    expect(result.confidence).toBe('none');
  });

  test('handles empty input', () => {
    const result = filterValidEmails([], 'Test');
    expect(result.best).toBeNull();
  });
});
