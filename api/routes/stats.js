// ─────────────────────────────────────────────────────────────
// Stats Routes — Dashboard data, engine health, pattern stats
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const { db, log, todayStr, ensureDailyStats, getDailyStats, formatNumber } = require('../config/database');
const search = require('../services/search');
const worker = require('../services/worker');
const ab = require('../services/antiblock');
const { abState, workCycle } = ab;

// Full stats for dashboard
router.get('/', (req, res) => {
  try {
    const today = todayStr();
    ensureDailyStats(today);
    const state = worker.getState();
    const wc = worker.getWorkCycle();

    const total = db.prepare('SELECT COUNT(*) as cnt FROM companies').get().cnt;
    const found = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('done','found') AND email IS NOT NULL AND email != ''").get().cnt;
    const notFound = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'not_found'").get().cnt;
    const errors = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status = 'error'").get().cnt;
    const pending = db.prepare("SELECT COUNT(*) as cnt FROM companies WHERE status IN ('pending','retry')").get().cnt;
    const processed = found + notFound + errors;
    const successRate = processed > 0 ? Math.round((found / processed) * 1000) / 10 : 0;
    const todayStats = getDailyStats(today);

    // Speed
    let currentSpeed = 0;
    if (state.recentSpeeds.length >= 2) {
      const elapsed = (state.recentSpeeds[state.recentSpeeds.length - 1] - state.recentSpeeds[0]) / 1000 / 60;
      currentSpeed = elapsed > 0 ? Math.round((state.recentSpeeds.length / elapsed) * 10) / 10 : 0;
    }
    let avgSpeed = 0;
    if (state.sessionStartTime && state.sessionProcessed > 0) {
      const sessionMinutes = (Date.now() - new Date(state.sessionStartTime).getTime()) / 1000 / 60;
      avgSpeed = sessionMinutes > 0 ? Math.round((state.sessionProcessed / sessionMinutes) * 10) / 10 : 0;
    }

    // Daily history
    const dailyHistory = db.prepare('SELECT date, processed, found, not_found, errors, blocks_detected FROM daily_stats ORDER BY date DESC LIMIT 30').all();

    // Recent results
    const recent = db.prepare(`
      SELECT company_name as company, email, status, substr(updated_at, 12, 8) as time
      FROM companies WHERE processed_date LIKE ? AND status IN ('done','found','not_found')
      ORDER BY updated_at DESC
    `).all(`${today}%`);

    // All found
    const allFound = db.prepare(`
      SELECT company_name as company, email, source_url as source, status,
             substr(processed_date, 1, 10) as date, substr(updated_at, 12, 8) as time
      FROM companies WHERE status IN ('done','found') AND email IS NOT NULL AND email != ''
      ORDER BY updated_at DESC
    `).all();

    // Error log
    const errorLog = db.prepare(`
      SELECT company_name as company, error_message as error, substr(updated_at, 12, 8) as time
      FROM companies WHERE processed_date LIKE ? AND status IN ('error','retry')
      ORDER BY updated_at DESC LIMIT 50
    `).all(`${today}%`);

    // System status
    let systemStatus = 'idle';
    if (state.workerRunning) {
      systemStatus = 'running';
    } else if (state.sessionStartTime) {
      const lastActivity = state.recentSpeeds.length > 0 ? state.recentSpeeds[state.recentSpeeds.length - 1] : 0;
      const sinceLastActivity = lastActivity > 0 ? (Date.now() - lastActivity) / 1000 : Infinity;
      if (sinceLastActivity < 120) systemStatus = 'running';
      else if (sinceLastActivity < 600) systemStatus = 'paused';
    }

    // Error rate
    const errorRate = abState.errorBuffer.length >= 5 ? abState.errorBuffer.filter(Boolean).length / abState.errorBuffer.length : 0;
    let abStatus = 'normal';
    if (errorRate > 0.5) abStatus = 'paused';
    else if (errorRate > 0.3) abStatus = 'throttled';

    const lastUpdatedTs = state.recentSpeeds.length > 0 ? new Date(state.recentSpeeds[state.recentSpeeds.length - 1]).toISOString() : null;

    res.json({
      total_companies: total, processed, found, not_found: notFound, errors, pending, success_rate: successRate,
      current_speed: currentSpeed, avg_speed: avgSpeed, status: systemStatus, last_updated: lastUpdatedTs,
      anti_block: {
        status: abStatus,
        blocks_today: state.sessionBlocksDetected,
        error_rate: Math.round(ab.getErrorRate() * 100),
        error_rate: Math.round(errorRate * 100),
        engine_health: Object.fromEntries(
          Object.entries(search.engineHealth).map(([name, h]) => [name, {
            healthy: h.healthy, fail_count: h.failCount,
            suspended_until: h.suspendedUntil > Date.now() ? new Date(h.suspendedUntil).toISOString() : null,
          }])
        ),
        healthy_engines: search.getHealthyEngines(),
      },
      session: {
        active: state.sessionStartTime !== null, start_time: state.sessionStartTime || '',
        companies_this_session: state.sessionProcessed, found_this_session: state.sessionFound,
        blocks_detected: state.sessionBlocksDetected, current_speed: currentSpeed, avg_speed: avgSpeed,
        error_rate: Math.round(ab.getErrorRate() * 100),
      },
      today: {
        date: today, processed: todayStats.processed, found: todayStats.found,
        not_found: todayStats.not_found, errors: todayStats.errors || 0,
        blocks_detected: todayStats.blocks_detected || 0,
      },
      work_cycle: {
        phase: wc.phase, cycle_count: wc.cycleCount, queries_this_phase: wc.queriesThisPhase,
        work_duration_min: Math.round((wc.workDuration || 0) / 60000),
        rest_duration_min: Math.round((wc.restDuration || 0) / 60000),
        phase_elapsed_min: wc.phaseStart ? Math.round((Date.now() - wc.phaseStart) / 60000) : 0,
        rest_remaining_min: Math.round(worker.getRestRemaining() / 60000),
        adaptive_delay: abState.adaptiveDelayMean,
      },
      daily_limit: worker.getDailyLimit(), daily_limit_tier: abState.dailyLimitTier,
      using_proxy: process.env.USE_PROXY === 'true',
      google_cse: {
        enabled: search.canUseGoogleCSE(), keys_count: search.GOOGLE_CSE_KEYS.length,
        total_used_today: search.getCseTotalUsedToday(),
        total_limit: search.GOOGLE_CSE_KEYS.length * search.GOOGLE_CSE_LIMIT_PER_KEY,
      },
      rejection_reasons: (() => {
        try {
          const days = parseInt(req.query.rejection_days) || 7;
          return db.prepare(`
            SELECT rejection_reason as reason, COUNT(*) as count FROM companies
            WHERE rejection_reason IS NOT NULL AND processed_date >= date('now', '-' || ? || ' days', 'localtime')
            GROUP BY rejection_reason ORDER BY count DESC
          `).all(days);
        } catch { return []; }
      })(),
      daily_history: dailyHistory, recent, all_found: allFound, error_log: errorLog,
      manual_mode: state.manualMode || 'auto',
    });
  } catch (err) {
    log(`ERROR /api/stats: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Engine health
router.get('/engines/health', async (req, res) => {
  try {
    const probeResults = {};
    for (const engine of ['google', 'bing', 'duckduckgo', 'startpage', 'brave', 'yahoo']) {
      try {
        const result = await search.searchSearXNG('"test" email', engine);
        const unresponsive = (result.unresponsive_engines || []).map(e => e[0]);
        probeResults[engine] = {
          responsive: !unresponsive.includes(engine),
          results_count: (result.results || []).length,
          unresponsive_reason: (result.unresponsive_engines || []).find(e => e[0] === engine)?.[1] || null,
        };
      } catch (err) {
        probeResults[engine] = { responsive: false, results_count: 0, error: err.message };
      }
    }
    res.json({ probe_results: probeResults, engine_health: search.engineHealth, healthy_engines: search.getHealthyEngines() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Engine reset
router.post('/engines/reset', (req, res) => {
  const { engine } = req.body || {};
  if (engine && search.engineHealth[engine]) {
    search.markEngineHealthy(engine);
    res.json({ success: true, engine, status: search.engineHealth[engine] });
  } else {
    for (const name of Object.keys(search.engineHealth)) search.markEngineHealthy(name);
    log('Manual reset: ALL engines marked healthy');
    res.json({ success: true, message: 'All engines reset' });
  }
});

// Pattern stats
router.get('/pattern-stats', (req, res) => {
  const stats = Object.entries(search.patternStats)
    .map(([pattern, s]) => ({ pattern, used: s.used, found: s.found, rate: s.used > 0 ? Math.round((s.found / s.used) * 100) : 0 }))
    .sort((a, b) => b.rate - a.rate);
  res.json({ patterns: stats });
});

module.exports = router;
