    // ============================================================
    // EmailHunter Dashboard v4.0 — JavaScript
    // ============================================================

    // ─── API Key Auth ────────────────────────────────────────────
    function getApiKey() {
      return localStorage.getItem('eh_api_key') || '';
    }

    function setApiKey(key) {
      localStorage.setItem('eh_api_key', key);
    }

    function apiHeaders() {
      const key = getApiKey();
      const headers = { 'Content-Type': 'application/json' };
      if (key) headers['X-API-Key'] = key;
      return headers;
    }

    async function apiFetch(url, options = {}) {
      const key = getApiKey();
      if (key) {
        options.headers = { ...options.headers, 'X-API-Key': key };
      }
      try {
        const res = await fetch(url, options);
        if (res.status === 401) {
          showAuthPrompt('API Key ไม่ถูกต้อง กรุณาใส่ใหม่');
          throw new Error('Unauthorized');
        }
        return res;
      } catch (err) {
        if (err.message !== 'Unauthorized') {
          console.error('API Error:', err);
        }
        throw err;
      }
    }

    function showAuthPrompt(message) {
      const key = prompt(message || 'กรุณาใส่ API Key เพื่อเข้าถึง Dashboard:');
      if (key) {
        setApiKey(key);
        location.reload();
      }
    }

    // ─── Loading State Helper ────────────────────────────────────
    function showLoading(elementId) {
      const el = document.getElementById(elementId);
      if (el) el.innerHTML = '<div class="text-center py-8 text-eh-text2">กำลังโหลด...</div>';
    }

    function showError(elementId, message) {
      const el = document.getElementById(elementId);
      if (el) el.innerHTML = '<div class="text-center py-8 text-eh-red">' + escapeHtml(message) + ' <button onclick="loadData()" class="ml-2 underline">ลองใหม่</button></div>';
    }

    let dailyChart = null;
    let donutChart = null;
    let cumulativeTrendChart = null;
    let dailySummaryChart = null;
    let isFirstLoad = true;
    let lastData = null;
    let selectedFile = null;

    // ============================================================
    // XSS Prevention
    // ============================================================
    function escapeHtml(str) {
      if (str === null || str === undefined) return '';
      const s = String(str);
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    // ============================================================
    // Number Formatting
    // ============================================================
    function formatNumber(n) {
      if (n === null || n === undefined) return '0';
      if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
      return n.toLocaleString('th-TH');
    }

    function formatSpeed(n) {
      if (n === null || n === undefined) return '0.0';
      return parseFloat(n).toFixed(1);
    }

    // ============================================================
    // Counter Animation (easeOutCubic)
    // ============================================================
    function animateCounter(el, target, suffix) {
      suffix = suffix || '';
      const duration = 1500;
      const start = parseInt(String(el.textContent).replace(/[^0-9]/g, '')) || 0;
      const diff = target - start;
      if (diff === 0) { el.textContent = formatNumber(target) + suffix; return; }

      const startTime = performance.now();
      function tick(now) {
        const elapsed = now - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(start + diff * eased);
        el.textContent = formatNumber(current) + suffix;
        if (progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }

    // ============================================================
    // Session Timeline
    // ============================================================
    function getSessionProgress() {
      const now = new Date();
      const hours = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
      if (hours >= 1 && hours <= 9) {
        return { active: true, progress: ((hours - 1) / 8) * 100, hours: hours };
      }
      // Calculate time until next 01:00
      let nextStart;
      if (hours > 9) {
        // Next day 01:00
        nextStart = new Date(now);
        nextStart.setDate(nextStart.getDate() + 1);
        nextStart.setHours(1, 0, 0, 0);
      } else {
        // Today 01:00
        nextStart = new Date(now);
        nextStart.setHours(1, 0, 0, 0);
      }
      const diffMs = nextStart - now;
      return { active: false, nextStartMs: diffMs };
    }

    function updateSessionTimeline() {
      const session = getSessionProgress();
      const fillEl = document.getElementById('sessionFill');
      const statusEl = document.getElementById('sessionStatus');
      const infoEl = document.getElementById('sessionInfo');
      const countdownEl = document.getElementById('sessionCountdown');
      const timeTextEl = document.getElementById('sessionTimeText');

      const now = new Date();
      const timeStr = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      if (session.active) {
        fillEl.style.width = Math.min(session.progress, 100) + '%';
        statusEl.textContent = 'Active';
        statusEl.className = 'text-xs text-eh-green font-medium';
        infoEl.classList.remove('hidden');
        countdownEl.classList.add('hidden');
        timeTextEl.textContent = 'Now: ' + timeStr + ' (' + session.progress.toFixed(1) + '%)';
      } else {
        fillEl.style.width = '0%';
        statusEl.textContent = 'Inactive';
        statusEl.className = 'text-xs text-eh-text2 font-medium';
        infoEl.classList.add('hidden');
        countdownEl.classList.remove('hidden');

        // Format countdown
        const totalSec = Math.floor(session.nextStartMs / 1000);
        const h = Math.floor(totalSec / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const countdownStr = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
        document.getElementById('countdownTimer').textContent = countdownStr;
      }

      // Update header clock
      document.getElementById('currentTime').textContent = now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    }

    // Update timeline every second
    setInterval(updateSessionTimeline, 1000);
    updateSessionTimeline();

    // ============================================================
    // Status Badge Helpers
    // ============================================================
    function createStatusBadge(status) {
      const span = document.createElement('span');
      span.className = 'px-2 py-0.5 rounded text-[10px] font-medium ';
      switch (status) {
        case 'done':
          span.className += 'badge-done';
          span.textContent = 'done';
          break;
        case 'not_found':
          span.className += 'badge-not-found';
          span.textContent = 'not found';
          break;
        case 'error':
          span.className += 'badge-error';
          span.textContent = 'error';
          break;
        case 'retry':
          span.className += 'badge-retry';
          span.textContent = 'retry';
          break;
        default:
          span.className += 'badge-pending';
          span.textContent = status || 'pending';
          break;
      }
      return span;
    }

    function createSourceBadge(source) {
      const span = document.createElement('span');
      span.className = 'px-2 py-0.5 rounded text-[10px] font-medium ';
      if (source === 'search') {
        span.className += 'badge-search';
        span.textContent = 'search';
      } else if (source === 'website') {
        span.className += 'badge-website';
        span.textContent = 'website';
      } else {
        span.className += 'badge-pending';
        span.textContent = source || '-';
      }
      return span;
    }

    // ============================================================
    // Calculate ETA
    // ============================================================
    function calcEta(stats) {
      if (!stats) return '-';
      const processed = stats.processed || 0;
      const total = stats.total_companies || 0;
      const remaining = total - processed;
      if (remaining <= 0) return 'Done!';

      // Use average speed if available, otherwise estimate from today
      const avgSpeed = stats.avg_speed || (stats.today ? stats.today.processed : 0);
      if (!avgSpeed || avgSpeed <= 0) return '-';

      // 480 minutes per day (8 hours session)
      const minutesPerDay = 480;
      const daysNeeded = remaining / (avgSpeed * minutesPerDay);

      if (daysNeeded < 1) return '< 1 day';
      if (daysNeeded < 30) return Math.ceil(daysNeeded) + ' days';
      const months = (daysNeeded / 30).toFixed(1);
      return months + ' mo';
    }

    // ============================================================
    // Update Dashboard
    // ============================================================
    function updateDashboard(data) {
      if (!data) return;
      lastData = data;

      // --- KPI Cards ---
      const elTotal = document.getElementById('statTotal');
      const elProcessed = document.getElementById('statProcessed');
      const elFound = document.getElementById('statFound');
      const elNotFound = document.getElementById('statNotFound');
      const elRate = document.getElementById('statRate');
      const elEta = document.getElementById('statEta');

      if (isFirstLoad) {
        animateCounter(elTotal, data.total_companies || 0);
        animateCounter(elProcessed, data.processed || 0);
        animateCounter(elFound, data.found || 0);
        animateCounter(elNotFound, data.not_found || 0);
        animateCounter(elRate, parseFloat(data.success_rate) || 0, '%');
        isFirstLoad = false;
      } else {
        elTotal.textContent = formatNumber(data.total_companies || 0);
        elProcessed.textContent = formatNumber(data.processed || 0);
        elFound.textContent = formatNumber(data.found || 0);
        elNotFound.textContent = formatNumber(data.not_found || 0);
        elRate.textContent = (parseFloat(data.success_rate) || 0).toFixed(1) + '%';
      }
      elEta.textContent = calcEta(data);

      // --- Session Info ---
      const sessionProcessedEl = document.getElementById('sessionProcessed');
      const sessionSpeedEl = document.getElementById('sessionSpeed');
      const sessionBlocksEl = document.getElementById('sessionBlocks');
      sessionProcessedEl.textContent = formatNumber(data.today ? data.today.processed : 0) + ' processed';
      sessionSpeedEl.textContent = formatSpeed(data.current_speed || data.avg_speed || 0) + '/min';
      const blocks = (data.anti_block ? data.anti_block.blocks_today : 0) || 0;
      sessionBlocksEl.textContent = blocks + ' blocks';
      if (blocks > 0) {
        sessionBlocksEl.style.color = '#ff3366';
      } else {
        sessionBlocksEl.style.color = '';
      }

      // --- Speed Gauge ---
      const speed = parseFloat(data.current_speed || data.avg_speed || 0);
      const speedEl = document.getElementById('speedGauge');
      speedEl.textContent = formatSpeed(speed);
      speedEl.className = 'speed-gauge ';
      if (speed >= 4) {
        speedEl.className += 'speed-good';
      } else if (speed >= 2) {
        speedEl.className += 'speed-mid';
      } else {
        speedEl.className += 'speed-slow';
      }

      document.getElementById('speedAvg').textContent = formatSpeed(data.avg_speed || 0) + '/min';

      // Speed trend
      const trendEl = document.getElementById('speedTrend');
      const trend = data.speed_trend || 'stable';
      if (trend === 'increasing' || trend === 'up') {
        trendEl.textContent = 'Increasing';
        trendEl.style.color = '#00ff88';
      } else if (trend === 'decreasing' || trend === 'down') {
        trendEl.textContent = 'Decreasing';
        trendEl.style.color = '#ff3366';
      } else {
        trendEl.textContent = 'Stable';
        trendEl.style.color = '#fbbf24';
      }

      // --- Anti-Block Status ---
      const ab = data.anti_block || {};
      const abStatus = ab.status || 'normal';
      const abStatusEl = document.getElementById('antiBlockStatus');
      const shieldEl = document.getElementById('shieldIcon');
      const blockWarningEl = document.getElementById('blockWarning');

      if (abStatus === 'throttled') {
        abStatusEl.textContent = 'Throttled';
        abStatusEl.style.color = '#fbbf24';
        shieldEl.className = 'shield-icon shield-throttled';
      } else if (abStatus === 'paused') {
        abStatusEl.textContent = 'Paused';
        abStatusEl.style.color = '#ff3366';
        shieldEl.className = 'shield-icon shield-paused';
      } else {
        abStatusEl.textContent = 'Normal';
        abStatusEl.style.color = '#00ff88';
        shieldEl.className = 'shield-icon shield-normal';
      }

      document.getElementById('queriesUntilBreak').textContent = ab.queries_until_break != null ? ab.queries_until_break : '-';
      document.getElementById('blocksToday').textContent = blocks;

      // --- Work Cycle Status ---
      var wc = data.work_cycle || {};
      var wcPhaseEl = document.getElementById('workCyclePhase');
      var wcCountEl = document.getElementById('workCycleCount');
      if (wcPhaseEl) {
        var phaseLabels = { working: 'Working', resting: 'Resting', long_rest: 'Long Rest', idle: 'Idle' };
        var phaseText = phaseLabels[wc.phase] || 'Idle';
        if (wc.phase === 'resting' && wc.rest_remaining_min > 0) {
          phaseText += ' (' + wc.rest_remaining_min + ' min left)';
        }
        if (wc.phase === 'working' && wc.work_duration_min > 0) {
          phaseText += ' (' + wc.phase_elapsed_min + '/' + wc.work_duration_min + ' min)';
        }
        wcPhaseEl.textContent = phaseText;
        wcPhaseEl.style.color = wc.phase === 'working' ? '#00ff88' : wc.phase === 'resting' ? '#fbbf24' : '#6366f1';
      }
      if (wcCountEl) wcCountEl.textContent = wc.cycle_count || 0;

      // Update daily limit display
      if (data.daily_limit) {
        var limitEl = document.getElementById('counterToday');
        if (limitEl) limitEl.title = 'Daily limit: ' + formatNumber(data.daily_limit);
      }

      if (blocks > 0) {
        blockWarningEl.classList.remove('hidden');
      } else {
        blockWarningEl.classList.add('hidden');
      }

      // --- Progress Bar ---
      const total = data.total_companies || 1;
      const pct = ((data.processed || 0) / total * 100).toFixed(1);
      document.getElementById('progressFill').style.width = pct + '%';
      document.getElementById('progressText').textContent =
        pct + '% (' + formatNumber(data.processed || 0) + ' / ' + formatNumber(data.total_companies || 0) + ')';

      // --- Charts ---
      updateDailySummaryChart(data);
      updateCumulativeTrendChart(data);
      updateDailyChart(data);
      updateDonutChart(data);
      updateRejectionChart(data);

      // --- Tables ---
      window._allFound = data.all_found || [];
      window._recentToday = data.recent || [];
      var activeTab = window._activeResultTab || 'all';
      if (activeTab === 'all') {
        updateActivityTable(window._allFound, true);
      } else {
        updateActivityTable(window._recentToday, false);
      }
      updateErrorTable(data.error_log || []);

      // --- Export count ---
      document.getElementById('exportCount').textContent = formatNumber(data.found || 0);

      // --- Footer ---
      const lastUp = data.last_updated ? new Date(data.last_updated).toLocaleString('th-TH') : '-';
      document.getElementById('lastUpdated').textContent = 'Last updated: ' + lastUp;
      document.getElementById('todayStats').textContent =
        'Today: ' + (data.today ? data.today.processed : 0) + ' processed, ' + (data.today ? data.today.found : 0) + ' found';

      // --- Status badge ---
      updateStatusBadge(data);

      // --- Manual mode + actual status indicator ---
      updateModeUI(data.manual_mode || 'auto', data.status || 'idle');

      // --- Live counters (Today + This Run) ---
      document.getElementById('counterToday').textContent = data.today ? (data.today.found || 0) : 0;
      document.getElementById('counterSession').textContent = data.session ? (data.session.found_this_session || 0) : 0;
    }

    // ============================================================
    // Status Badge
    // ============================================================
    function updateStatusBadge(data) {
      const dotEl = document.querySelector('#statusBadge .pulse-dot');
      const textEl = document.getElementById('statusText');
      if (!dotEl || !textEl) return;

      const status = data.status || 'unknown';

      if (status === 'running') {
        dotEl.className = 'pulse-dot';
        textEl.textContent = 'Running';
        textEl.className = 'text-eh-green font-medium';
      } else if (status === 'paused') {
        dotEl.className = 'pulse-dot pulse-dot-paused';
        textEl.textContent = 'Paused';
        textEl.className = 'text-eh-red font-medium';
      } else if (status === 'idle') {
        dotEl.className = 'pulse-dot pulse-dot-idle';
        textEl.textContent = 'Idle';
        textEl.className = 'text-eh-yellow font-medium';
      } else {
        // Fallback: check last_updated
        if (data.last_updated) {
          const diff = Date.now() - new Date(data.last_updated).getTime();
          if (diff > 3600000) {
            dotEl.className = 'pulse-dot pulse-dot-idle';
            textEl.textContent = 'Idle';
            textEl.className = 'text-eh-yellow font-medium';
          } else {
            dotEl.className = 'pulse-dot';
            textEl.textContent = 'Running';
            textEl.className = 'text-eh-green font-medium';
          }
        }
      }
    }

    function showOfflineStatus() {
      const dotEl = document.querySelector('#statusBadge .pulse-dot');
      const textEl = document.getElementById('statusText');
      if (dotEl) dotEl.className = 'pulse-dot pulse-dot-offline';
      if (textEl) {
        textEl.textContent = 'Offline';
        textEl.className = 'text-eh-text2 font-medium';
      }
    }

    // ============================================================
    // Charts
    // ============================================================
    const chartDefaults = {
      tooltipStyle: {
        backgroundColor: '#12121a',
        borderColor: '#1e1e3a',
        borderWidth: 1,
        titleFont: { family: 'JetBrains Mono' },
        bodyFont: { family: 'JetBrains Mono' },
        titleColor: '#e2e8f0',
        bodyColor: '#e2e8f0',
      },
      fontStyle: { family: 'JetBrains Mono', size: 10 },
      gridColor: 'rgba(30,30,58,0.5)',
    };

    // Fill missing dates to get continuous 14-day range
    function buildFullDateRange(historyData, todayData) {
      // Build a map of date → data
      var dateMap = {};
      var rawHistory = [...(historyData || [])].reverse();
      for (var i = 0; i < rawHistory.length; i++) {
        if (rawHistory[i].date) dateMap[rawHistory[i].date] = rawHistory[i];
      }
      // Add today (overwrite if exists)
      if (todayData && todayData.date) {
        dateMap[todayData.date] = todayData;
      }

      // Generate last 14 days
      var days = [];
      var now = new Date();
      for (var d = 13; d >= 0; d--) {
        var dt = new Date(now);
        dt.setDate(dt.getDate() - d);
        var key = dt.toISOString().slice(0, 10);
        days.push({
          date: key,
          processed: dateMap[key] ? (dateMap[key].processed || 0) : 0,
          found: dateMap[key] ? (dateMap[key].found || 0) : 0,
          not_found: dateMap[key] ? (dateMap[key].not_found || 0) : 0,
          errors: dateMap[key] ? (dateMap[key].errors || 0) : 0,
        });
      }
      return days;
    }

    function updateDailySummaryChart(data) {
      var days = buildFullDateRange(data.daily_history, data.today);

      var labels = days.map(function(d) { return d.date.slice(5); });

      var totalData = days.map(function(d) { return d.processed || 0; });
      var doneData = days.map(function(d) { return (d.found || 0) + (d.not_found || 0) + (d.errors || 0); });
      var foundData = days.map(function(d) { return d.found || 0; });
      var notFoundData = days.map(function(d) { return d.not_found || 0; });
      var rateData = days.map(function(d) {
        var done = (d.found || 0) + (d.not_found || 0);
        return done > 0 ? Math.round((d.found / done) * 1000) / 10 : 0;
      });

      if (dailySummaryChart) {
        dailySummaryChart.data.labels = labels;
        dailySummaryChart.data.datasets[0].data = totalData;
        dailySummaryChart.data.datasets[1].data = doneData;
        dailySummaryChart.data.datasets[2].data = foundData;
        dailySummaryChart.data.datasets[3].data = notFoundData;
        dailySummaryChart.data.datasets[4].data = rateData;
        dailySummaryChart.update('none');
      } else {
        var ctx = document.getElementById('dailySummaryChart');
        if (!ctx) return;
        dailySummaryChart = new Chart(ctx.getContext('2d'), {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Total',
                data: totalData,
                backgroundColor: 'rgba(0, 212, 255, 0.6)',
                borderColor: '#00d4ff',
                borderWidth: 1,
                borderRadius: 4,
                yAxisID: 'y',
                order: 4,
              },
              {
                label: 'Done',
                data: doneData,
                backgroundColor: 'rgba(168, 85, 247, 0.5)',
                borderColor: '#a855f7',
                borderWidth: 1,
                borderRadius: 4,
                yAxisID: 'y',
                order: 3,
              },
              {
                label: 'Found',
                data: foundData,
                backgroundColor: 'rgba(0, 255, 136, 0.6)',
                borderColor: '#00ff88',
                borderWidth: 1,
                borderRadius: 4,
                yAxisID: 'y',
                order: 2,
              },
              {
                label: 'Not Found',
                data: notFoundData,
                backgroundColor: 'rgba(255, 51, 102, 0.5)',
                borderColor: '#ff3366',
                borderWidth: 1,
                borderRadius: 4,
                yAxisID: 'y',
                order: 1,
              },
              {
                label: 'Rate %',
                type: 'line',
                data: rateData,
                borderColor: '#fbbf24',
                backgroundColor: 'transparent',
                borderWidth: 2.5,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#fbbf24',
                pointBorderColor: '#0a0a0f',
                pointBorderWidth: 2,
                borderDash: [6, 3],
                tension: 0.3,
                yAxisID: 'y1',
                order: 0,
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false,
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: 'rgba(18,18,26,0.95)',
                titleColor: '#e2e8f0',
                bodyColor: '#e2e8f0',
                borderColor: '#1e1e3a',
                borderWidth: 1,
                padding: 12,
                bodyFont: chartDefaults.fontStyle,
                titleFont: chartDefaults.fontStyle,
                callbacks: {
                  label: function(ctx) {
                    if (ctx.dataset.label === 'Rate %') {
                      return ctx.dataset.label + ': ' + ctx.parsed.y + '%';
                    }
                    return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString();
                  }
                }
              },
            },
            scales: {
              x: {
                ticks: { color: '#64748b', font: chartDefaults.fontStyle, maxRotation: 45 },
                grid: { color: 'rgba(30,30,58,0.3)' }
              },
              y: {
                type: 'linear',
                display: true,
                position: 'left',
                beginAtZero: true,
                title: { display: true, text: 'จำนวน/วัน', color: '#64748b', font: chartDefaults.fontStyle },
                ticks: { color: '#64748b', font: chartDefaults.fontStyle },
                grid: { color: 'rgba(30,30,58,0.3)' },
              },
              y1: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Rate %', color: '#fbbf24', font: chartDefaults.fontStyle },
                ticks: { color: '#fbbf24', font: chartDefaults.fontStyle, callback: function(v) { return v + '%'; } },
                grid: { drawOnChartArea: false },
                min: 0,
                max: 100,
              }
            }
          }
        });
      }
    }

    function updateCumulativeTrendChart(data) {
      var days = buildFullDateRange(data.daily_history, data.today);

      var labels = days.map(function(d) { return d.date.slice(5); }); // MM-DD

      // Build cumulative data
      var cumTotal = [], cumFound = [], cumNotFound = [], rateData = [];
      var runTotal = 0, runFound = 0, runNotFound = 0;
      for (var i = 0; i < days.length; i++) {
        runTotal += days[i].processed;
        runFound += days[i].found;
        runNotFound += days[i].not_found;
        cumTotal.push(runTotal);
        cumFound.push(runFound);
        cumNotFound.push(runNotFound);
        rateData.push(runTotal > 0 ? Math.round((runFound / runTotal) * 1000) / 10 : 0);
      }

      if (cumulativeTrendChart) {
        cumulativeTrendChart.data.labels = labels;
        cumulativeTrendChart.data.datasets[0].data = cumTotal;
        cumulativeTrendChart.data.datasets[1].data = cumFound;
        cumulativeTrendChart.data.datasets[2].data = cumNotFound;
        cumulativeTrendChart.data.datasets[3].data = rateData;
        cumulativeTrendChart.update('none');
      } else {
        var ctx = document.getElementById('cumulativeTrendChart');
        if (!ctx) return;
        cumulativeTrendChart = new Chart(ctx.getContext('2d'), {
          type: 'line',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Total (สะสม)',
                data: cumTotal,
                borderColor: '#00d4ff',
                backgroundColor: 'rgba(0, 212, 255, 0.05)',
                fill: true,
                borderWidth: 3,
                pointRadius: 5,
                pointHoverRadius: 7,
                pointBackgroundColor: '#00d4ff',
                pointBorderColor: '#0a0a0f',
                pointBorderWidth: 2,
                tension: 0.4,
                yAxisID: 'y',
              },
              {
                label: 'Found (สะสม)',
                data: cumFound,
                borderColor: '#00ff88',
                backgroundColor: 'rgba(0, 255, 136, 0.08)',
                fill: true,
                borderWidth: 3,
                pointRadius: 5,
                pointHoverRadius: 7,
                pointBackgroundColor: '#00ff88',
                pointBorderColor: '#0a0a0f',
                pointBorderWidth: 2,
                tension: 0.4,
                yAxisID: 'y',
              },
              {
                label: 'Not Found (สะสม)',
                data: cumNotFound,
                borderColor: '#ff3366',
                backgroundColor: 'rgba(255, 51, 102, 0.05)',
                fill: true,
                borderWidth: 2,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#ff3366',
                pointBorderColor: '#0a0a0f',
                pointBorderWidth: 2,
                tension: 0.4,
                yAxisID: 'y',
              },
              {
                label: 'Rate %',
                data: rateData,
                borderColor: '#fbbf24',
                backgroundColor: 'transparent',
                fill: false,
                borderWidth: 2.5,
                pointRadius: 4,
                pointHoverRadius: 6,
                pointBackgroundColor: '#fbbf24',
                pointBorderColor: '#0a0a0f',
                pointBorderWidth: 2,
                borderDash: [6, 3],
                tension: 0.4,
                yAxisID: 'y1',
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
              mode: 'index',
              intersect: false,
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                backgroundColor: 'rgba(18,18,26,0.95)',
                titleColor: '#e2e8f0',
                bodyColor: '#e2e8f0',
                borderColor: '#1e1e3a',
                borderWidth: 1,
                padding: 12,
                bodyFont: chartDefaults.fontStyle,
                titleFont: chartDefaults.fontStyle,
                callbacks: {
                  label: function(ctx) {
                    if (ctx.dataset.label === 'Rate %') {
                      return ctx.dataset.label + ': ' + ctx.parsed.y + '%';
                    }
                    return ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString();
                  }
                }
              },
            },
            scales: {
              x: {
                ticks: { color: '#64748b', font: chartDefaults.fontStyle, maxRotation: 45 },
                grid: { color: 'rgba(30,30,58,0.3)' }
              },
              y: {
                type: 'linear',
                display: true,
                position: 'left',
                beginAtZero: true,
                title: { display: true, text: 'จำนวนสะสม', color: '#64748b', font: chartDefaults.fontStyle },
                ticks: { color: '#64748b', font: chartDefaults.fontStyle },
                grid: { color: 'rgba(30,30,58,0.3)' },
              },
              y1: {
                type: 'linear',
                display: true,
                position: 'right',
                title: { display: true, text: 'Rate %', color: '#fbbf24', font: chartDefaults.fontStyle },
                ticks: { color: '#fbbf24', font: chartDefaults.fontStyle, callback: function(v) { return v + '%'; } },
                grid: { drawOnChartArea: false },
                min: 0,
                max: 100,
              }
            }
          }
        });
      }
    }

    function updateDailyChart(data) {
      var days = buildFullDateRange(data.daily_history, data.today);

      var labels = days.map(function(d) { return d.date.slice(5); });
      var found = days.map(function(d) { return d.found || 0; });
      var notFound = days.map(function(d) { return d.not_found || 0; });
      var errors = days.map(function(d) { return d.errors || 0; });

      if (dailyChart) {
        dailyChart.data.labels = labels;
        dailyChart.data.datasets[0].data = found;
        dailyChart.data.datasets[1].data = notFound;
        dailyChart.data.datasets[2].data = errors;
        dailyChart.update('none');
      } else {
        var ctx = document.getElementById('dailyChart');
        if (!ctx) return;
        dailyChart = new Chart(ctx.getContext('2d'), {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [
              {
                label: 'Found',
                data: found,
                backgroundColor: 'rgba(0, 255, 136, 0.7)',
                borderColor: '#00ff88',
                borderWidth: 1,
                borderRadius: 4,
              },
              {
                label: 'Not Found',
                data: notFound,
                backgroundColor: 'rgba(255, 51, 102, 0.5)',
                borderColor: '#ff3366',
                borderWidth: 1,
                borderRadius: 4,
              },
              {
                label: 'Errors',
                data: errors,
                backgroundColor: 'rgba(251, 191, 36, 0.5)',
                borderColor: '#fbbf24',
                borderWidth: 1,
                borderRadius: 4,
              }
            ]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                labels: { color: '#64748b', font: chartDefaults.fontStyle }
              },
              tooltip: chartDefaults.tooltipStyle,
            },
            scales: {
              x: { stacked: true, ticks: { color: '#64748b', font: chartDefaults.fontStyle }, grid: { color: chartDefaults.gridColor } },
              y: { stacked: true, ticks: { color: '#64748b', font: chartDefaults.fontStyle }, grid: { color: chartDefaults.gridColor } }
            }
          }
        });
      }
    }

    function updateDonutChart(data) {
      const found = data.found || 0;
      const notFound = data.not_found || 0;
      const errors = data.errors || 0;
      const total = found + notFound + errors || 1;

      if (donutChart) {
        donutChart.data.datasets[0].data = [found, notFound, errors];
        donutChart.update('none');
      } else {
        var ctx = document.getElementById('donutChart');
        if (!ctx) return;
        donutChart = new Chart(ctx.getContext('2d'), {
          type: 'doughnut',
          data: {
            labels: ['Found', 'Not Found', 'Errors'],
            datasets: [{
              data: [found, notFound, errors],
              backgroundColor: ['#00ff88', '#ff3366', '#fbbf24'],
              borderColor: '#12121a',
              borderWidth: 3,
              hoverOffset: 8,
            }]
          },
          options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '65%',
            plugins: {
              legend: {
                position: 'bottom',
                labels: { color: '#64748b', font: chartDefaults.fontStyle, padding: 16, usePointStyle: true, pointStyleWidth: 8 }
              },
              tooltip: {
                ...chartDefaults.tooltipStyle,
                callbacks: {
                  label: function(ctx) {
                    var pct = ((ctx.parsed / total) * 100).toFixed(1);
                    return ctx.label + ': ' + formatNumber(ctx.parsed) + ' (' + pct + '%)';
                  }
                }
              }
            }
          }
        });
      }
    }

    // ============================================================
    // Rejection Reasons Chart
    // ============================================================
    var rejectionChart = null;
    window._rejectionDays = 7;

    var REJECTION_LABELS = {
      'search_no_results': 'No Search Results',
      'search_no_emails': 'Results but No Emails',
      'crawl_no_emails': 'Crawl Found Nothing',
      'all_filtered': 'All Emails Filtered',
      'engine_blocked': 'Engines Blocked',
      'timeout': 'Request Timeout',
    };
    var REJECTION_COLORS = {
      'search_no_results': '#6366f1',
      'search_no_emails': '#f97316',
      'crawl_no_emails': '#eab308',
      'all_filtered': '#ef4444',
      'engine_blocked': '#ec4899',
      'timeout': '#64748b',
    };

    function setRejectionDays(days) {
      window._rejectionDays = days;
      document.querySelectorAll('.rej-btn').forEach(function(btn) {
        var d = parseInt(btn.getAttribute('data-days'));
        if (d === days) {
          btn.className = 'rej-btn px-3 py-1 text-xs rounded-full bg-eh-purple/20 text-eh-purple border border-eh-purple/30';
        } else {
          btn.className = 'rej-btn px-3 py-1 text-xs rounded-full border border-eh-text2/20 text-eh-text2';
        }
      });
      // Re-fetch with new day range
      apiFetch('/api/stats?rejection_days=' + days).then(function(r) { return r.json(); }).then(function(data) {
        updateRejectionChart(data);
      }).catch(function() {});
    }

    function updateRejectionChart(data) {
      var reasons = data.rejection_reasons || [];
      if (reasons.length === 0) return;

      var labels = reasons.map(function(r) { return REJECTION_LABELS[r.reason] || r.reason; });
      var values = reasons.map(function(r) { return r.count; });
      var colors = reasons.map(function(r) { return REJECTION_COLORS[r.reason] || '#94a3b8'; });

      var ctx = document.getElementById('rejectionChart');
      if (!ctx) return;

      if (rejectionChart) {
        rejectionChart.data.labels = labels;
        rejectionChart.data.datasets[0].data = values;
        rejectionChart.data.datasets[0].backgroundColor = colors;
        rejectionChart.update();
      } else {
        rejectionChart = new Chart(ctx.getContext('2d'), {
          type: 'bar',
          data: {
            labels: labels,
            datasets: [{
              data: values,
              backgroundColor: colors,
              borderRadius: 4,
              barThickness: 18,
            }]
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: {
                ...chartDefaults.tooltipStyle,
                callbacks: {
                  label: function(ctx) {
                    var total = values.reduce(function(a, b) { return a + b; }, 0);
                    var pct = total > 0 ? ((ctx.parsed.x / total) * 100).toFixed(1) : '0';
                    return formatNumber(ctx.parsed.x) + ' (' + pct + '%)';
                  }
                }
              }
            },
            scales: {
              x: { grid: { color: 'rgba(148,163,184,0.08)' }, ticks: { color: '#64748b', font: chartDefaults.fontStyle } },
              y: { grid: { display: false }, ticks: { color: '#94a3b8', font: { size: 11 } } }
            }
          }
        });
      }
    }

    // ============================================================
    // Tables (XSS-safe using DOM manipulation)
    // ============================================================
    window._activeResultTab = 'all';
    function switchResultTab(tab) {
      window._activeResultTab = tab;
      var btnAll = document.getElementById('tabAll');
      var btnToday = document.getElementById('tabToday');
      if (tab === 'all') {
        btnAll.className = 'px-3 py-1 text-xs rounded-full bg-eh-green/20 text-eh-green border border-eh-green/30';
        btnToday.className = 'px-3 py-1 text-xs rounded-full bg-eh-card text-eh-text2 border border-eh-border hover:border-eh-blue/30';
        updateActivityTable(window._allFound || [], true);
      } else {
        btnToday.className = 'px-3 py-1 text-xs rounded-full bg-eh-blue/20 text-eh-blue border border-eh-blue/30';
        btnAll.className = 'px-3 py-1 text-xs rounded-full bg-eh-card text-eh-text2 border border-eh-border hover:border-eh-green/30';
        updateActivityTable(window._recentToday || [], false);
      }
    }

    function updateActivityTable(recent, isAllMode) {
      var tbody = document.getElementById('activityBody');
      if (!tbody) return;

      // Update tab counts
      var tabAllCount = document.getElementById('tabAllCount');
      var tabTodayCount = document.getElementById('tabTodayCount');
      if (tabAllCount && window._allFound) tabAllCount.textContent = formatNumber(window._allFound.length);
      if (tabTodayCount && window._recentToday) tabTodayCount.textContent = formatNumber(window._recentToday.length);

      // Clear existing rows
      tbody.textContent = '';

      if (!recent || !recent.length) {
        var emptyRow = document.createElement('tr');
        var emptyTd = document.createElement('td');
        emptyTd.setAttribute('colspan', '6');
        emptyTd.className = 'text-center text-eh-text2 py-8';
        emptyTd.textContent = isAllMode ? 'ยังไม่มีผลลัพธ์' : 'ยังไม่มีข้อมูลวันนี้';
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
        return;
      }

      var items = recent;
      for (var i = 0; i < items.length; i++) {
        var r = items[i];
        var tr = document.createElement('tr');

        // Row number
        var tdNum = document.createElement('td');
        tdNum.className = 'text-eh-text2 text-center';
        tdNum.textContent = i + 1;
        tr.appendChild(tdNum);

        // Time (show date if all mode)
        var tdTime = document.createElement('td');
        tdTime.className = 'text-eh-text2 whitespace-nowrap';
        tdTime.textContent = isAllMode ? (r.date || '') + ' ' + (r.time || '') : (r.time || '-');
        tr.appendChild(tdTime);

        // Company
        var tdCompany = document.createElement('td');
        tdCompany.className = 'text-eh-text max-w-[180px] truncate';
        tdCompany.textContent = r.company || '-';
        tdCompany.title = r.company || '';
        tr.appendChild(tdCompany);

        // Email
        var tdEmail = document.createElement('td');
        tdEmail.className = 'text-eh-blue max-w-[200px] truncate';
        tdEmail.textContent = r.email || '-';
        tdEmail.title = r.email || '';
        tr.appendChild(tdEmail);

        // Status
        var tdStatus = document.createElement('td');
        tdStatus.appendChild(createStatusBadge(r.status));
        tr.appendChild(tdStatus);

        // Source
        var tdSource = document.createElement('td');
        tdSource.appendChild(createSourceBadge(r.source));
        tr.appendChild(tdSource);

        tbody.appendChild(tr);
      }
    }

    function updateErrorTable(errors) {
      var tbody = document.getElementById('errorBody');
      if (!tbody) return;

      tbody.textContent = '';

      if (!errors || !errors.length) {
        var emptyRow = document.createElement('tr');
        var emptyTd = document.createElement('td');
        emptyTd.setAttribute('colspan', '3');
        emptyTd.className = 'text-center text-eh-text2 py-8';
        emptyTd.textContent = 'ไม่มี error';
        emptyRow.appendChild(emptyTd);
        tbody.appendChild(emptyRow);
        return;
      }

      var items = errors.slice(0, 10);
      for (var i = 0; i < items.length; i++) {
        var e = items[i];
        var tr = document.createElement('tr');

        var tdTime = document.createElement('td');
        tdTime.className = 'text-eh-text2 whitespace-nowrap';
        tdTime.textContent = e.time || '-';
        tr.appendChild(tdTime);

        var tdCompany = document.createElement('td');
        tdCompany.className = 'text-eh-text max-w-[150px] truncate';
        tdCompany.textContent = e.company || '-';
        tdCompany.title = e.company || '';
        tr.appendChild(tdCompany);

        var tdError = document.createElement('td');
        tdError.className = 'text-eh-red max-w-[250px] truncate';
        tdError.textContent = e.error || '-';
        tdError.title = e.error || '';
        tr.appendChild(tdError);

        tbody.appendChild(tr);
      }
    }

    // ============================================================
    // File Upload
    // ============================================================
    (function initUpload() {
      var zone = document.getElementById('uploadZone');
      var fileInput = document.getElementById('fileInput');
      if (!zone || !fileInput) return;

      // Click to select
      zone.addEventListener('click', function() {
        fileInput.click();
      });

      // File selected
      fileInput.addEventListener('change', function() {
        if (fileInput.files && fileInput.files.length > 0) {
          handleFileSelect(fileInput.files[0]);
        }
      });

      // Drag and drop
      zone.addEventListener('dragover', function(e) {
        e.preventDefault();
        zone.classList.add('dragover');
      });
      zone.addEventListener('dragleave', function(e) {
        e.preventDefault();
        zone.classList.remove('dragover');
      });
      zone.addEventListener('drop', function(e) {
        e.preventDefault();
        zone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          var file = e.dataTransfer.files[0];
          if (file.name.match(/\.(xlsx|xls)$/i)) {
            handleFileSelect(file);
          } else {
            alert('กรุณาเลือกไฟล์ .xlsx หรือ .xls เท่านั้น');
          }
        }
      });
    })();

    function handleFileSelect(file) {
      selectedFile = file;
      var fileInfoEl = document.getElementById('fileInfo');
      var fileNameEl = document.getElementById('fileName');
      var fileSizeEl = document.getElementById('fileSize');
      if (fileInfoEl && fileNameEl) {
        fileNameEl.textContent = file.name;
        if (fileSizeEl) {
          var sizeMB = (file.size / 1024 / 1024).toFixed(1);
          fileSizeEl.textContent = sizeMB > 1 ? '(' + sizeMB + ' MB)' : '(' + Math.round(file.size / 1024) + ' KB)';
        }
        fileInfoEl.classList.remove('hidden');
      }
      // ซ่อน dropzone เมื่อเลือกไฟล์แล้ว
      var zone = document.getElementById('uploadZone');
      if (zone) zone.classList.add('hidden');
      // Hide previous results
      var resultEl = document.getElementById('uploadResult');
      if (resultEl) resultEl.classList.add('hidden');
    }

    function resetUpload() {
      selectedFile = null;
      var fileInput = document.getElementById('fileInput');
      if (fileInput) fileInput.value = '';
      var fileInfo = document.getElementById('fileInfo');
      if (fileInfo) fileInfo.classList.add('hidden');
      var resultEl = document.getElementById('uploadResult');
      if (resultEl) resultEl.classList.add('hidden');
      var zone = document.getElementById('uploadZone');
      if (zone) zone.classList.remove('hidden');
    }

    function doUpload() {
      if (!selectedFile) return;

      var progressEl = document.getElementById('uploadProgress');
      var progressFillEl = document.getElementById('uploadProgressFill');
      var statusTextEl = document.getElementById('uploadStatusText');
      var resultEl = document.getElementById('uploadResult');
      var uploadBtn = document.getElementById('uploadBtn');
      var fileInfoEl = document.getElementById('fileInfo');

      if (progressEl) progressEl.classList.remove('hidden');
      if (resultEl) resultEl.classList.add('hidden');
      if (uploadBtn) { uploadBtn.disabled = true; uploadBtn.textContent = 'กำลังส่ง...'; }
      if (progressFillEl) progressFillEl.style.width = '0%';
      if (statusTextEl) statusTextEl.textContent = 'กำลังส่งไฟล์...';

      var formData = new FormData();
      formData.append('file', selectedFile);

      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/import', true);
      var apiKey = getApiKey();
      if (apiKey) xhr.setRequestHeader('X-API-Key', apiKey);

      xhr.upload.addEventListener('progress', function(e) {
        if (e.lengthComputable) {
          var pct = Math.round((e.loaded / e.total) * 100);
          if (progressFillEl) progressFillEl.style.width = pct + '%';
          if (pct >= 100) {
            if (statusTextEl) statusTextEl.textContent = 'กำลังประมวลผลข้อมูล... รอสักครู่';
          } else {
            if (statusTextEl) statusTextEl.textContent = 'กำลังส่งไฟล์... ' + pct + '%';
          }
        }
      });

      xhr.addEventListener('load', function() {
        if (progressEl) progressEl.classList.add('hidden');
        if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = 'Upload'; }

        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            var r = JSON.parse(xhr.responseText);
            var imported = r.imported || 0;
            var duplicates = r.duplicates || 0;
            var errors = r.errors || 0;
            var total = imported + duplicates + errors;
            var html = '';

            if (imported > 0 && errors === 0) {
              // สำเร็จ — มีข้อมูลใหม่
              html = '<div class="px-4 py-3 bg-eh-green/10 border border-eh-green/30 rounded-lg">'
                + '<div class="flex items-center gap-2 mb-2">'
                + '<svg class="w-5 h-5 text-eh-green" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
                + '<span class="text-eh-green font-bold">Upload สำเร็จ!</span></div>'
                + '<div class="text-eh-text text-xs space-y-1 ml-7">'
                + '<p>เพิ่มบริษัทใหม่ <strong class="text-eh-green">' + formatNumber(imported) + '</strong> รายการ</p>'
                + (duplicates > 0 ? '<p class="text-eh-text2">ข้ามบริษัทที่มีอยู่แล้ว ' + formatNumber(duplicates) + ' รายการ</p>' : '')
                + '</div>'
                + '<div class="mt-2 ml-7"><button onclick="resetUpload()" class="text-xs text-eh-text2 hover:text-eh-green underline">Upload ไฟล์อื่น</button></div>'
                + '</div>';
            } else if (imported === 0 && duplicates > 0 && errors === 0) {
              // ไม่มีข้อมูลใหม่ — ซ้ำหมด
              html = '<div class="px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">'
                + '<div class="flex items-center gap-2 mb-2">'
                + '<svg class="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
                + '<span class="text-yellow-400 font-bold">ไม่มีข้อมูลใหม่</span></div>'
                + '<div class="text-eh-text text-xs space-y-1 ml-7">'
                + '<p>บริษัททั้ง ' + formatNumber(duplicates) + ' รายการ มีอยู่ในระบบแล้ว</p>'
                + '<p class="text-eh-text2">กรุณาใช้ไฟล์ที่มีบริษัทใหม่</p>'
                + '</div>'
                + '<div class="mt-2 ml-7"><button onclick="resetUpload()" class="text-xs text-eh-text2 hover:text-yellow-400 underline">Upload ไฟล์อื่น</button></div>'
                + '</div>';
            } else if (errors > 0) {
              // มี error
              html = '<div class="px-4 py-3 bg-eh-red/10 border border-eh-red/30 rounded-lg">'
                + '<div class="flex items-center gap-2 mb-2">'
                + '<svg class="w-5 h-5 text-eh-red" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
                + '<span class="text-eh-red font-bold">Upload มีปัญหาบางส่วน</span></div>'
                + '<div class="text-eh-text text-xs space-y-1 ml-7">'
                + (imported > 0 ? '<p>เพิ่มบริษัทใหม่ <strong class="text-eh-green">' + formatNumber(imported) + '</strong> รายการ</p>' : '')
                + (duplicates > 0 ? '<p>ข้ามบริษัทที่มีอยู่แล้ว ' + formatNumber(duplicates) + ' รายการ</p>' : '')
                + '<p class="text-eh-red">ข้อมูลผิดพลาด ' + formatNumber(errors) + ' รายการ (ชื่อบริษัทว่าง)</p>'
                + '</div>'
                + '<div class="mt-2 ml-7"><button onclick="resetUpload()" class="text-xs text-eh-text2 hover:text-eh-red underline">Upload ไฟล์อื่น</button></div>'
                + '</div>';
            } else {
              // imported=0, duplicates=0, errors=0 — ไฟล์ว่าง
              html = '<div class="px-4 py-3 bg-yellow-500/10 border border-yellow-500/30 rounded-lg">'
                + '<div class="flex items-center gap-2 mb-2">'
                + '<svg class="w-5 h-5 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
                + '<span class="text-yellow-400 font-bold">ไม่พบข้อมูลในไฟล์</span></div>'
                + '<div class="text-eh-text text-xs ml-7"><p>ไฟล์อาจว่างหรือไม่มีคอลัมน์ชื่อบริษัท</p></div>'
                + '<div class="mt-2 ml-7"><button onclick="resetUpload()" class="text-xs text-eh-text2 hover:text-yellow-400 underline">Upload ไฟล์อื่น</button></div>'
                + '</div>';
            }

            if (resultEl) { resultEl.innerHTML = html; resultEl.classList.remove('hidden'); }
            if (fileInfoEl) fileInfoEl.classList.add('hidden');
            fetchStats();
          } catch(e) {
            showUploadError('ไม่สามารถอ่านผลลัพธ์จาก server ได้');
          }
        } else {
          var errMsg = 'Upload ล้มเหลว';
          try { errMsg = JSON.parse(xhr.responseText).error || errMsg; } catch(e) {}
          showUploadError(errMsg);
        }
      });

      xhr.addEventListener('error', function() {
        if (progressEl) progressEl.classList.add('hidden');
        if (uploadBtn) { uploadBtn.disabled = false; uploadBtn.textContent = 'Upload'; }
        showUploadError('ไม่สามารถเชื่อมต่อ server ได้ กรุณาลองใหม่');
      });

      xhr.send(formData);
    }

    function showUploadError(msg) {
      var resultEl = document.getElementById('uploadResult');
      if (resultEl) {
        resultEl.innerHTML = '<div class="px-4 py-3 bg-eh-red/10 border border-eh-red/30 rounded-lg">'
          + '<div class="flex items-center gap-2 mb-1">'
          + '<svg class="w-5 h-5 text-eh-red" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>'
          + '<span class="text-eh-red font-bold text-sm">' + msg + '</span></div>'
          + '<div class="mt-2 ml-7"><button onclick="resetUpload()" class="text-xs text-eh-text2 hover:text-eh-red underline">ลองใหม่</button></div>'
          + '</div>';
        resultEl.classList.remove('hidden');
      }
    }

    // ============================================================
    // Reset All Data
    // ============================================================
    async function resetAllData() {
      if (!confirm('WARNING: ลบข้อมูลทั้งหมด (companies, stats, session) เพื่อเริ่มต้นใหม่?\n\nกด OK เพื่อยืนยัน')) return;
      if (!confirm('ยืนยันอีกครั้ง: ข้อมูลจะถูกลบถาวร ไม่สามารถกู้คืนได้')) return;
      try {
        var res = await apiFetch('/api/reset', { method: 'POST' });
        var data = await res.json();
        if (data.success) {
          alert('Reset สำเร็จ! ข้อมูลทั้งหมดถูกลบแล้ว');
          location.reload();
        } else {
          alert('Reset ล้มเหลว: ' + (data.error || 'Unknown error'));
        }
      } catch(e) {
        alert('Reset ล้มเหลว: ' + e.message);
      }
    }

    // ============================================================
    // Manual Session Control — Toggle Button
    // ============================================================
    var currentMode = 'auto';

    function toggleSession() {
      // Toggle: idle/auto → start, running → stop, stopped → start
      if (currentMode === 'running') {
        sessionControl('stop');
      } else {
        sessionControl('start');
      }
    }

    async function sessionControl(action) {
      try {
        var res = await apiFetch('/api/session/' + action, { method: 'POST' });
        var data = await res.json();
        if (data.success) {
          updateModeUI(data.mode, action === 'start' ? 'running' : 'idle');
          fetchStats();
        }
      } catch(e) {
        console.warn('Session control failed:', e.message);
      }
    }

    function updateModeUI(mode, systemStatus) {
      // ใช้ทั้ง mode (manual flag) และ systemStatus (actual activity) เพื่อแสดงสถานะจริง
      var actuallyRunning = (systemStatus === 'running') || (mode === 'running' && systemStatus !== 'idle');
      currentMode = actuallyRunning ? 'running' : mode;

      var btn = document.getElementById('btnToggle');
      var icon = document.getElementById('toggleIcon');
      var label = document.getElementById('toggleLabel');
      var autoBtn = document.getElementById('btnAutoReset');

      if (actuallyRunning || mode === 'running') {
        // กำลังทำงานจริงๆ → แสดงปุ่ม Stop (สีแดง กระพริบ)
        btn.className = 'session-toggle state-running px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-2';
        icon.innerHTML = '&#9632;';
        label.textContent = actuallyRunning ? 'Running...' : 'Starting...';
        autoBtn.classList.remove('hidden');
        currentMode = 'running';
      } else if (mode === 'stopped') {
        // ถูก stop โดย user → แสดงปุ่ม Start (สีเทา)
        btn.className = 'session-toggle state-stopped px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-2';
        icon.innerHTML = '&#9654;';
        label.textContent = 'Stopped';
        autoBtn.classList.remove('hidden');
      } else {
        // Auto mode ปกติ → แสดงปุ่ม Start (สีเขียว พร้อมกด)
        btn.className = 'session-toggle state-idle px-4 py-1.5 rounded-full text-xs font-bold transition-all cursor-pointer flex items-center gap-2';
        icon.innerHTML = '&#9654;';
        label.textContent = 'Start';
        autoBtn.classList.add('hidden');
      }
    }

    // ============================================================
    // Fetch Data
    // ============================================================
    async function fetchStats() {
      try {
        var res = await apiFetch('/api/stats?' + Date.now());
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = await res.json();
        updateDashboard(data);
      } catch(e) {
        console.warn('Fetch stats failed:', e.message);
        showOfflineStatus();
      }
    }

    // ============================================================
    // Health Check
    // ============================================================
    async function checkHealth() {
      try {
        var res = await apiFetch('/api/health?' + Date.now());
        if (!res.ok) showOfflineStatus();
      } catch(e) {
        // Health check failed silently
      }
    }

    // ============================================================
    // Init
    // ============================================================
    fetchStats();
    setInterval(fetchStats, 15000);
    setInterval(checkHealth, 60000);
