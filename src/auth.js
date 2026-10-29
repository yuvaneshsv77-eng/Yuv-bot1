const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE_NAME = 'yuvbot_session';

function issueSession(res, email) {
  const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME);
}

function readSession(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return null;
  }
}

// Requires a logged-in user (any verified email session).
function requireAuth(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.user = session;
  next();
}

// Requires the admin password to have been supplied for this request.
// Simple single-owner gate - not per-user roles.
function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-password'];
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected || provided !== expected) {
    return res.status(401).json({ error: 'Invalid admin password' });
  }
  next();
}

module.exports = { issueSession, clearSession, readSession, requireAuth, requireAdmin, COOKIE_NAME };
