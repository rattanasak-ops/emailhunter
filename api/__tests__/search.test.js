jest.mock('../config/database', () => ({
  log: () => {},
  todayStr: () => '2026-04-01',
}));

jest.mock('../services/notification', () => ({
  notifyLark: () => {},
}));

const search = require('../services/search');

describe('search engine backoff', () => {
  afterEach(() => {
    for (const name of Object.keys(search.engineHealth)) {
      search.markEngineHealthy(name);
    }
    search.resetAllDown();
  });

  test('does not fallback to real engines when all engines are unhealthy', () => {
    for (const name of Object.keys(search.engineHealth)) {
      search.engineHealth[name].healthy = false;
      search.engineHealth[name].suspendedUntil = Date.now() + 60 * 60 * 1000;
    }

    expect(() => search.pickEnginesForQuery()).toThrow(/all engines unhealthy/);
  });
});

describe('retry query tier selection', () => {
  test('search misses retry official/contact tiers before directory/social', () => {
    expect(search.getRetryTiers('search_no_emails')).toEqual([2, 3, 4]);
    expect(search.getRetryTiers('search_no_results')).toEqual([2, 3, 4]);
    expect(search.getRetryTiers('crawl_no_emails')).toEqual([2, 3, 4]);
  });

  test('all-filtered retry can use official plus directory/social evidence tiers', () => {
    expect(search.getRetryTiers('all_filtered')).toEqual([2, 3, 5, 6]);
  });
});

describe('official recovery queries', () => {
  test('builds contact-focused queries with noise terms excluded', () => {
    const queries = search.buildOfficialRecoveryQueries('บริษัท ทดสอบ จำกัด');
    expect(queries).toHaveLength(3);
    expect(queries.join(' ')).toContain('official website contact');
    expect(queries.join(' ')).toContain('-job');
    expect(queries.join(' ')).toContain('-ข่าว');
  });
});
