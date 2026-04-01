// ─────────────────────────────────────────────────────────────
// Notification Service — Lark + LINE
// ─────────────────────────────────────────────────────────────

const https = require('https');
const { log } = require('../config/database');

// ─── Lark API ────────────────────────────────────────────────
let larkTokenCache = { token: null, expiresAt: 0 };

function getLarkToken() {
  return new Promise((resolve, reject) => {
    const appId = process.env.LARK_APP_ID;
    const appSecret = process.env.LARK_APP_SECRET;
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
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

function sendLarkCard(title, contentMd, color = 'green') {
  return new Promise(async (resolve, reject) => {
    try {
      const token = await getLarkToken();
      const chatId = process.env.LARK_CHAT_ID;
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
      req.on('error', reject);
      req.write(postData);
      req.end();
    } catch (e) { reject(e); }
  });
}

function notifyLark(title, contentMd, color = 'green') {
  sendLarkCard(title, contentMd, color).catch(err => {
    log(`Lark notify failed: ${err.message}`);
  });
}

// ─── LINE Notify (legacy) ────────────────────────────────────
function sendLineNotify(message) {
  return new Promise((resolve, reject) => {
    const token = process.env.LINE_NOTIFY_TOKEN;
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
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

module.exports = { notifyLark, sendLarkCard, sendLineNotify };
