# Yuv Bot — Backend

A real Node/Express backend for the Yuv Bot resume assistant: email login,
server-side session cookies, a SQLite-backed resume store shared by every
visitor, and a chat endpoint that proxies to the Anthropic API so the API
key never reaches the browser.

## What's inside

```
yuvbot-backend/
  server.js            Express app: auth, resume, and chat routes
  src/db.js             SQLite setup (users, resume, chat_logs tables)
  src/auth.js            Session cookie helpers + admin password gate
  public/app.html         The frontend (login -> landing -> chat -> admin)
  .env.example             Copy to .env and fill in real values
  package.json
```

## Setup

```bash
cd yuvbot-backend
npm install
cp .env.example .env
```

Edit `.env`:
- `JWT_SECRET` — any long random string (used to sign session cookies)
- `ADMIN_PASSWORD` — the password you'll type into the admin editor to save resume changes
- `ANTHROPIC_API_KEY` — your real API key (starts with `sk-ant-...`)
- `ANTHROPIC_MODEL` — leave as `claude-sonnet-4-6` unless you want a different model

Then run it:

```bash
npm start
```

Visit `http://localhost:3000`. Confirm it's actually up with `curl http://localhost:3000/api/health`.

## Production-readiness additions

To make this feel like a real deployable service rather than a demo:

- **`helmet`** sets standard security headers (CSP is disabled since the
  page loads Google Fonts + Google Identity Services from external CDNs —
  tighten this if you remove those).
- **`express-rate-limit`** on auth routes (20 requests / 15 min per IP) and
  on `/api/chat` (15 messages / min per IP) so the Anthropic API key can't
  be hammered by a script and login can't be brute-forced freely.
- **`morgan`** request logging (concise in dev, Apache-combined format in
  production).
- **`GET /api/health`** for uptime monitors / container orchestrators to
  poll.
- **Centralized error handler** — anything thrown in a route that wasn't
  already caught returns JSON, never a raw stack trace or an HTML error
  page.
- **Graceful shutdown** on `SIGTERM`/`SIGINT` closes the SQLite connection
  cleanly instead of risking a corrupted write on redeploy.
- **Input length caps** (800 chars per chat message) to keep costs and
  abuse bounded.
- **`.gitignore`** excluding `node_modules`, `.env`, and the SQLite data
  files so secrets and local data never get committed.

## Resume content

The bundled resume (`DEFAULT_RESUME` in `src/db.js`) reflects Yuvanesh's
current resume: three shipped projects (MockPrep, FinPay Backend, Yuv Bot
itself), the Tech Volt internship, and the expanded skill set (TypeScript,
Redis, Docker, Prisma, Anthropic Claude API, Google OAuth). Update it any
time from the in-app admin editor (see "Login experience" below) — that
change is what the chatbot answers from, live, without touching code.

## Login experience

- **Boot animation**: on first load, before anything else renders, the page
  cycles through "Calling Yuv Bot..." → "Connecting to Yuv Bot..." → "AI mode
  activated" with a progress bar, then reveals the login card.
- **Login card**: centered, dark card with a "Continue with Google" primary
  button and email/password sign-in/sign-up tabs below a divider — matches
  the SanBot-style reference layout.
- **Google Sign-In**: to enable the button, create an OAuth Client ID at
  https://console.cloud.google.com/apis/credentials (type "Web application"),
  add your site's URL (e.g. `http://localhost:3000`) under "Authorized
  JavaScript origins", and put the client ID in `.env` as `GOOGLE_CLIENT_ID`.
  Without it, the button is hidden and a small note tells visitors to use
  email instead — the app still works fully on email/password alone.

## Matching the resume bullet points

Three things were added specifically so "RAG-based assistant," "real-time
streaming via SSE," and "glassmorphism UI" are actually true of this build,
not just aspirational copy:

- **RAG retrieval** (`src/db.js: retrieveRelevantChunks`) — the resume is
  split into labeled chunks (SUMMARY, EXPERIENCE, PROJECTS, EDUCATION, ...).
  Each question is scored against those chunks by keyword overlap, and only
  the top-matching chunks (plus identity/summary for grounding) are sent to
  the model — not the entire resume every time. This is intentionally a
  lightweight, dependency-free retriever (no embeddings, no vector DB)
  because a single short resume doesn't need one; the honest description is
  "retrieval-augmented," not "semantic/vector search." If you want the
  latter for a larger corpus, swap this function for an embeddings + cosine
  similarity lookup (e.g. via Pinecone, pgvector, or even an in-memory
  array for small corpora).
- **SSE streaming** (`POST /api/chat`) — the endpoint sets
  `Content-Type: text/event-stream` and forwards Anthropic's own streaming
  response token-by-token as `delta` events, finishing with a `done` event.
  The frontend reads the stream and appends text to the bubble as it
  arrives, with a blinking cursor while it's still going.
- **Glassmorphism UI** — the login card, nav, sidebar, topbar, chat
  bubbles, composer, and topic chips all use translucent backgrounds
  (`rgba` fills) with `backdrop-filter: blur(...)` over the glowing
  gradient background, instead of flat opaque panels.

## How it works

- **Sign in / Create account** (`POST /api/auth/login`, `POST /api/auth/register`)
  is real email+password auth: passwords are hashed with bcrypt (12 rounds)
  before hitting the database, never stored in plain text. A signed, httpOnly
  JWT cookie is issued on success. Login is rate-limited per email (6 failed
  attempts locks it out for 15 minutes, in-memory — fine for one instance,
  swap for Redis if you run more than one).
- **Chat** (`POST /api/chat`) requires a valid session cookie, pulls the
  current resume from SQLite, builds the grounded system prompt, and calls
  the Anthropic API server-side. The API key stays in `.env` and never
  reaches client JavaScript. Every Q&A pair is logged to `chat_logs` so you
  can see what people are asking.
- **Resume editing** (`GET`/`PUT /api/resume`) is shared, not per-browser —
  saving in the admin view updates the database, so every visitor's chat
  immediately uses the new content. `PUT` requires the `x-admin-password`
  header to match `ADMIN_PASSWORD`.
- **Search/ask page**: the chat view doubles as the search page — the input
  box is the search bar, and clicking a suggested topic on the landing page
  redirects into this same chat view with that question pre-asked.

## Hardening before a real deployment

This is a working starting point, not a production auth system. Before
pointing real users at it:

1. **Add email verification.** Right now anyone can register with any email
   they don't own. Add a verification link/OTP step (e.g. via Resend,
   Postmark, or SES) before treating an email as confirmed.
2. **Add password reset.** There's no "forgot password" flow yet — you'd
   need a token-based reset link sent by email.
3. **Move ADMIN_PASSWORD to a proper admin login** with its own session
   instead of a header compared on every request.
4. **Rate-limit `/api/chat`** (e.g. `express-rate-limit`) so the Anthropic
   key can't be hammered by a script.
5. **Use HTTPS in production** (`secure: true` on the cookie is already
   gated behind `NODE_ENV=production`).
6. **Swap SQLite for Postgres** if you deploy somewhere without persistent
   disk (e.g. most serverless platforms) — Railway, Render, or a small VPS
   all support persistent disk if you'd rather keep SQLite.

## Deploying (step by step)

This repo now includes `Dockerfile`, `railway.json`, and `render.yaml`, so
either of these platforms deploys directly from the repo with no extra
config.

### Option A: Railway (recommended - simplest persistent disk)

1. Push this project to a GitHub repo (Railway deploys from a repo, not a
   zip upload).
2. Go to https://railway.app → **New Project** → **Deploy from GitHub
   repo** → pick the repo. Railway detects the `Dockerfile` automatically.
3. Once the service is created, go to its **Variables** tab and add:
   - `JWT_SECRET` - a long random string (e.g. run `openssl rand -hex 32`)
   - `ADMIN_PASSWORD` - your resume-editor password
   - `ANTHROPIC_API_KEY` - your real key
   - `ANTHROPIC_MODEL` - `claude-sonnet-4-6`
   - `GOOGLE_CLIENT_ID` - optional, only if you set up Google Sign-In
   - `NODE_ENV` - `production`
4. Go to the **Settings** tab → **Volumes** → add a volume mounted at
   `/app/data`. This is what makes the SQLite database (and everyone's
   accounts/chat history) survive redeploys instead of resetting every time.
5. Go to **Settings** → **Networking** → **Generate Domain**. Railway gives
   you a public `*.up.railway.app` URL - that's your live site.
6. If you set up Google Sign-In, go back to
   https://console.cloud.google.com/apis/credentials and add that Railway
   URL under "Authorized JavaScript origins" (Google won't allow the sign-in
   flow from an unlisted origin).

### Option B: Render

1. Push to GitHub, then https://render.com → **New** → **Blueprint** → point
   it at the repo. Render reads `render.yaml` and creates the web service,
   the persistent disk at `/app/data`, and the env var slots automatically.
2. Fill in the values Render prompts for (`JWT_SECRET`, `ADMIN_PASSWORD`,
   `ANTHROPIC_API_KEY`, `GOOGLE_CLIENT_ID`) in its dashboard - same values as
   above.
3. Render gives you a `*.onrender.com` URL once the build finishes.

### Option C: Any other Docker host (Fly.io, a VPS, etc.)

```bash
docker build -t yuv-bot .
docker run -d -p 3000:3000 \
  -e JWT_SECRET=... -e ADMIN_PASSWORD=... -e ANTHROPIC_API_KEY=... \
  -e NODE_ENV=production \
  -v yuvbot_data:/app/data \
  yuv-bot
```

The `-v yuvbot_data:/app/data` is the important part — without a mounted
volume there, the SQLite database (and every signup/chat log) resets on
every container restart.

### What I can't do from here

I don't have a way to push to your GitHub, hold your Anthropic/Google
credentials, or click through a hosting dashboard on your behalf — those
steps above need you to actually do them once. Everything else (the code,
the Dockerfile, the platform configs) is already in this repo ready to go;
if you hit an error on any specific step, paste it back and I'll help debug
it directly.
