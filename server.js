require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const { db, getResume, setResume, createUser, findUserByEmail, logChat, retrieveRelevantChunks } = require('./src/db');
const { issueSession, clearSession, readSession, requireAuth, requireAdmin } = require('./src/auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // needed for correct client IPs behind Railway/Render/etc. reverse proxies

app.use(helmet({
  contentSecurityPolicy: false // the frontend loads Google Fonts + Google Identity Services from CDNs
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check for uptime monitors / container orchestrators.
app.get('/api/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Auth endpoints get a tighter limit to slow down credential-stuffing/spam signups.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' }
});

// Chat is the expensive route (it calls the Anthropic API) - keep it from being hammered.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending messages too quickly. Please slow down.' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

// Very small in-memory throttle to slow down brute-force attempts per email.
// Fine for a single-instance deploy; swap for a shared store (Redis) at scale.
const loginAttempts = new Map(); // email -> { count, resetAt }
function isRateLimited(email) {
  const entry = loginAttempts.get(email);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) { loginAttempts.delete(email); return false; }
  return entry.count >= 6;
}
function recordFailedAttempt(email) {
  const entry = loginAttempts.get(email) || { count: 0, resetAt: Date.now() + 15 * 60 * 1000 };
  entry.count += 1;
  loginAttempts.set(email, entry);
}
function clearAttempts(email) {
  loginAttempts.delete(email);
}

/* ---------------- Auth ---------------- */

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters.` });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: 'An account with that email already exists. Try signing in instead.' });
  }

  const passwordHash = await bcrypt.hash(password, 12);
  createUser(email, passwordHash);
  issueSession(res, email);
  res.json({ ok: true, email });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !EMAIL_RE.test(email) || !password) {
    return res.status(400).json({ error: 'Enter your email and password.' });
  }
  if (isRateLimited(email)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  }

  const user = findUserByEmail(email);
  if (!user) {
    recordFailedAttempt(email);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }
  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) {
    recordFailedAttempt(email);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  clearAttempts(email);
  issueSession(res, email);
  res.json({ ok: true, email });
});

app.post('/api/auth/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ email: session.email });
});

// Lets the frontend know whether Google Sign-In is configured, and with what client ID.
app.get('/api/auth/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null });
});

const { OAuth2Client } = require('google-auth-library');
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

app.post('/api/auth/google', authLimiter, async (req, res) => {
  const { credential } = req.body || {};
  if (!googleClient) {
    return res.status(500).json({ error: 'Google Sign-In is not configured on the server.' });
  }
  if (!credential) {
    return res.status(400).json({ error: 'Missing Google credential.' });
  }

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: process.env.GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    if (!email) {
      return res.status(400).json({ error: 'Google account has no email.' });
    }

    let user = findUserByEmail(email);
    if (!user) {
      // OAuth-only accounts still need a password_hash column filled;
      // store a random, unusable hash since they'll only ever sign in via Google.
      const randomHash = await bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 12);
      user = createUser(email, randomHash);
    }

    issueSession(res, email);
    res.json({ ok: true, email });
  } catch (err) {
    console.error('Google sign-in failed:', err);
    res.status(401).json({ error: 'Could not verify Google sign-in.' });
  }
});

/* ---------------- Resume ---------------- */

// Public read so the chat route (and any future client rendering) can use it.
app.get('/api/resume', (req, res) => {
  res.json({ content: getResume() });
});

// Admin-only write, gated by ADMIN_PASSWORD header (see .env).
app.put('/api/resume', requireAdmin, (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'Resume content is required.' });
  }
  setResume(content);
  res.json({ ok: true });
});

/* ---------------- Chat ---------------- */

function buildSystemPrompt(resumeContext) {
  return `You are Yuv Bot, answering questions on behalf of Yuvanesh SV to recruiters and hiring managers.
Rules:
- Only use facts contained in the RESUME CONTEXT below. Never invent dates, employers, skills, or metrics.
- If asked something the resume doesn't cover, say plainly that it isn't in the resume, and suggest what to ask instead.
- Keep answers concise (2-5 sentences) and factual, written in third person about Yuvanesh.
- When relevant, end the answer with a short bracketed tag naming the resume section it came from, e.g. [summary], [skills], [experience], [projects], [education].

RESUME CONTEXT:
${resumeContext}`;
}

app.post('/api/chat', chatLimiter, async (req, res) => {
  const { message } = req.body || {};
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'A message is required.' });
  }
  if (message.length > 800) {
    return res.status(400).json({ error: 'Message is too long (max 800 characters).' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY.' });
  }

  // Set up the SSE stream up front so the client can start rendering tokens
  // as soon as they arrive, instead of waiting for the full answer.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // Retrieval step: pull only the resume chunks relevant to this question
    // (always includes identity/summary for grounding) instead of dumping
    // the entire resume into every prompt.
    const resumeContext = retrieveRelevantChunks(getResume(), message, 3);
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
        max_tokens: 1000,
        stream: true,
        system: buildSystemPrompt(resumeContext),
        messages: [{ role: 'user', content: message }]
      })
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => '');
      console.error('Anthropic API error:', upstream.status, errText);
      send('error', { error: 'Upstream model error.' });
      return res.end();
    }

    let fullAnswer = '';
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep the last (possibly partial) line for next chunk

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (!payload || payload === '[DONE]') continue;
        let evt;
        try { evt = JSON.parse(payload); } catch { continue; }

        if (evt.type === 'content_block_delta' && evt.delta && evt.delta.type === 'text_delta') {
          fullAnswer += evt.delta.text;
          send('delta', { text: evt.delta.text });
        }
      }
    }

    logChat('visitor', message, fullAnswer);
    send('done', { answer: fullAnswer });
    res.end();
  } catch (err) {
    console.error('Chat route failed:', err);
    send('error', { error: 'Something went wrong answering that.' });
    res.end();
  }
});

/* ---------------- Fallback ---------------- */

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'app.html'));
});

// Centralized error handler - catches anything thrown/rejected in a route
// that wasn't already caught, and always responds with JSON instead of
// leaking a stack trace or an HTML error page.
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on the server.' });
});

const server = app.listen(PORT, () => {
  console.log(`Yuv Bot backend running on http://localhost:${PORT}`);
});

// Graceful shutdown so the SQLite WAL file closes cleanly instead of being
// killed mid-write when the process is stopped (e.g. by a platform redeploy).
function shutdown(signal) {
  console.log(`${signal} received, shutting down...`);
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
