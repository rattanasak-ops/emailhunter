// ─────────────────────────────────────────────────────────────
// API Key Authentication Middleware
// ─────────────────────────────────────────────────────────────

const API_KEY = process.env.API_KEY || '';

function authMiddleware(req, res, next) {
  // Health check ไม่ต้อง auth (สำหรับ Docker healthcheck)
  if (req.path === '/api/health') return next();
  // ถ้าไม่ได้ตั้ง API_KEY ใน env → ข้าม auth (backward compatible)
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'] || req.query.api_key;
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized — invalid or missing API key' });
  }
  next();
}

module.exports = authMiddleware;
