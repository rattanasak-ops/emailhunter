// ─────────────────────────────────────────────────────────────
// Notification Service — Lark Webhook + Lark App + LINE
// ─────────────────────────────────────────────────────────────

const https = require('https');
const { log } = require('../config/database');
const NOTIFY_TIMEOUT_MS = 10000;

function configuredValue(value) {
  if (!value) return '';
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === '__REPLACE_ME__') return '';
  return trimmed;
}

function getConfiguredWebhookUrl() {
  const webhookUrl = configuredValue(process.env.LARK_WEBHOOK_URL);
  if (!webhookUrl) return '';
  try {
    const url = new URL(webhookUrl);
    if (url.protocol !== 'https:') return '';
    return webhookUrl;
  } catch {
    return '';
  }
}

// ─── Lark Webhook (simple — no auth needed) ──────────────────
function notifyLarkWebhook(title, contentMd, color = 'blue') {
  const webhookUrl = getConfiguredWebhookUrl();
  if (!webhookUrl) return;

  const colorMap = { green: 'green', red: 'red', yellow: 'yellow', blue: 'blue' };
  const card = {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: `EmailHunter | ${title}` },
      template: colorMap[color] || 'blue',
    },
    elements: [
      { tag: 'markdown', content: contentMd },
      {
        tag: 'note',
        elements: [{
          tag: 'plain_text',
          content: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }),
        }],
      },
    ],
  };

  const postData = JSON.stringify({ msg_type: 'interactive', card });
  try {
    const url = new URL(webhookUrl);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) log(`Lark webhook error ${res.statusCode}: ${data}`);
      });
    });
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => {
      req.destroy(new Error('Lark webhook timeout'));
    });
    req.on('error', err => log(`Lark webhook error: ${err.message}`));
    req.write(postData);
    req.end();
  } catch (e) {
    log(`Lark webhook error: ${e.message}`);
  }
}

// ─── Lark App API (requires LARK_APP_ID + LARK_APP_SECRET) ───
let larkTokenCache = { token: null, expiresAt: 0 };

function getLarkToken() {
  return new Promise((resolve, reject) => {
    const appId = configuredValue(process.env.LARK_APP_ID);
    const appSecret = configuredValue(process.env.LARK_APP_SECRET);
    if (!appId || !appSecret) return reject(new Error('LARK_APP_ID/SECRET not set'));

    if (larkTokenCache.token && Date.now() < larkTokenCache.expiresAt) {
      return resolve(larkTokenCache.token);
    }

    const postData = JSON.stringify({ app_id: appId, app_secret: appSecret });
    const options = {
      hostname: 'open.larksuite.com',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.tenant_access_token) {
            larkTokenCache = {
              token: json.tenant_access_token,
              expiresAt: Date.now() + (json.expire - 300) * 1000,
            };
            resolve(json.tenant_access_token);
          } else {
            reject(new Error(`Lark token error: ${data}`));
          }
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => {
      req.destroy(new Error('Lark token timeout'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendLarkCard(title, contentMd, color = 'green') {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getLarkToken();
      const chatId = configuredValue(process.env.LARK_CHAT_ID);
      if (!chatId) return reject(new Error('LARK_CHAT_ID not set'));

      const colorMap = { green: 'green', red: 'red', yellow: 'yellow', blue: 'blue' };
      const card = {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: 'plain_text', content: title },
          template: colorMap[color] || 'blue',
        },
        elements: [
          { tag: 'markdown', content: contentMd },
          { tag: 'note', elements: [{ tag: 'plain_text', content: `EmailHunter | ${new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })}` }] },
        ],
      };

      const postData = JSON.stringify({
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      });

      const options = {
        hostname: 'open.larksuite.com',
        path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) resolve({ success: true });
          else {
            log(`Lark API error ${res.statusCode}: ${data}`);
            reject(new Error(`Lark ${res.statusCode}`));
          }
        });
      });
      req.setTimeout(NOTIFY_TIMEOUT_MS, () => {
        req.destroy(new Error('Lark send timeout'));
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    } catch (e) { reject(e); }
  });
}

// ─── Unified notify — webhook first, fallback to App API ─────
function notifyLark(title, contentMd, color = 'green') {
  if (getConfiguredWebhookUrl()) {
    notifyLarkWebhook(title, contentMd, color);
  } else if (configuredValue(process.env.LARK_APP_ID)) {
    sendLarkCard(title, contentMd, color).catch(err => {
      log(`Lark notify failed: ${err.message}`);
    });
  }
}

// ─── LINE Notify (legacy) ────────────────────────────────────
function sendLineNotify(message) {
  return new Promise((resolve, reject) => {
    const token = configuredValue(process.env.LINE_NOTIFY_TOKEN);
    if (!token) return reject(new Error('LINE_NOTIFY_TOKEN not set'));

    const postData = `message=${encodeURIComponent(message)}`;
    const options = {
      hostname: 'notify-api.line.me',
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve({ success: true });
        else reject(new Error(`LINE API returned ${res.statusCode}: ${data}`));
      });
    });
    req.setTimeout(NOTIFY_TIMEOUT_MS, () => {
      req.destroy(new Error('LINE notify timeout'));
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { notifyLark, notifyLarkWebhook, sendLarkCard, sendLineNotify, configuredValue, getConfiguredWebhookUrl };
