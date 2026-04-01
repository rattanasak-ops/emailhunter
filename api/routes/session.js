// ─────────────────────────────────────────────────────────────
// Session Routes — Start/Stop/Status
// ─────────────────────────────────────────────────────────────

const express = require('express');
const router = express.Router();
const worker = require('../services/worker');
const search = require('../services/search');
const { getProcessedToday } = require('../config/database');

// Start session
router.post('/start', (req, res) => {
  worker.start();
  res.json({ success: true, mode: 'running', message: 'Processing started.' });
});

// Stop session
router.post('/stop', (req, res) => {
  const state = worker.getState();
  worker.stop();
  res.json({
    success: true, mode: 'stopped',
    message: `Stopped. This run: ${state.sessionProcessed} processed, ${state.sessionFound} found.`,
  });
});

// Auto mode (idle)
router.post('/auto', (req, res) => {
  worker.setAuto();
  res.json({ success: true, mode: 'auto', message: 'System idle. Press Start to begin.' });
});

// Session status
router.get('/status', (req, res) => {
  const state = worker.getState();
  const wc = worker.getWorkCycle();
  res.json({
    mode: state.manualMode || 'auto',
    set_at: state.manualModeSetAt,
    worker_running: state.workerRunning,
    session_active: state.sessionStartTime !== null,
    session_start: state.sessionStartTime,
    processed_today: getProcessedToday(),
    daily_limit: worker.getDailyLimit(),
    google_cse: {
      enabled: search.canUseGoogleCSE(),
      keys_count: search.GOOGLE_CSE_KEYS.length,
      used_today: search.getCseTotalUsedToday(),
      limit: search.GOOGLE_CSE_KEYS.length * search.GOOGLE_CSE_LIMIT_PER_KEY,
      remaining: Math.max(0, (search.GOOGLE_CSE_KEYS.length * search.GOOGLE_CSE_LIMIT_PER_KEY) - search.getCseTotalUsedToday()),
    },
    work_cycle: {
      phase: wc.phase,
      cycle_count: wc.cycleCount,
      queries_this_phase: wc.queriesThisPhase,
      rest_remaining_ms: worker.getRestRemaining(),
      phase_start: wc.phaseStart ? new Date(wc.phaseStart).toISOString() : null,
    },
  });
});

module.exports = router;
