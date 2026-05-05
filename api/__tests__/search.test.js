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
