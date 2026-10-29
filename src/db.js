const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_RESUME = `
NAME: Yuvanesh SV
CONTACT: yuvaneshsv77@gmail.com | +91 97915 02238 | Tirupur, Tamil Nadu
TITLE: Full Stack Developer | JavaScript (ES6+), HTML5/CSS3, React.js, REST APIs, Git & GitHub

SUMMARY:
Full Stack Developer with internship experience building responsive web applications using JavaScript (ES6+), React.js, Node.js, Express.js, HTML5, CSS3, and MySQL. Skilled in developing RESTful APIs, integrating frontend and backend systems, optimizing application performance, and delivering scalable, user-centric solutions. Passionate about writing clean, maintainable code and continuously learning modern web technologies.

TECHNICAL SKILLS:
Languages: JavaScript (ES6+), TypeScript, Java, Python, SQL
Frontend: HTML5, CSS3, React.js, Bootstrap, Responsive Web Design, Flexbox, CSS Grid, DOM Manipulation, Recharts
Backend: Node.js, Express.js, Flask, Django, RESTful APIs, JWT Authentication
Database & Caching: MySQL, SQLite, Redis, CRUD Operations, Query Optimization, Schema Design, Prisma
DevOps & Tools: Docker, Git, GitHub, VS Code, Postman, Google OAuth
AI & APIs: Anthropic Claude API, LLM-integrated application design
Concepts: Object-Oriented Programming, Data Structures & Algorithms, DBMS, MVC Architecture, Clean Architecture (Service + Repository pattern), API Integration

PROJECTS:
1. MockPrep - AI Mock Learning Platform (React.js, Node.js, Express.js, MySQL, Claude API)
   - Built a full-stack AI interview platform with 5 test tracks and MCQ + descriptive modes, using the Claude API for real-time answer evaluation across 12 roles.
   - Implemented JWT authentication, a streak-based engagement system, and an analytics dashboard visualizing score trends using Recharts.

2. FinPay Backend (Node.js, TypeScript, Express.js, MySQL, Redis, Docker, JWT) - 2025
   - Designed and developed a production-ready FinTech Transaction Management System with Clean Architecture (MVC + Service + Repository pattern), handling user wallets, transfers, payments, and role-based access control.
   - Implemented an ACID-compliant money transfer engine using Prisma $transaction with a Redis caching layer, reducing database query load by approximately 60%.

3. Yuv Bot - AI Personal Assistant (Node.js, Express.js, Anthropic Claude, SQLite, Google OAuth)
   - Built an AI-powered personal assistant integrating structured resume and personal data into LLM workflows using Anthropic Claude.
   - Designed a responsive glassmorphism chat interface with resume-based question answering and conversation logging.

EXPERIENCE:
1. Full Stack Developer Intern - Tech Volt Software Pvt. Ltd., Coimbatore, India (Jan 2025 - Feb 2025)
   - Developed responsive and reusable UI components using HTML5, CSS3, JavaScript (ES6+), and React.js, improving application consistency and user experience.
   - Integrated frontend modules with RESTful APIs to enable seamless data communication and dynamic content rendering.

EDUCATION:
1. Bachelor of Engineering in Computer Science and Engineering - CGPA: 7.6 - KPR Institute of Engineering and Technology, Coimbatore, India (2023 - 2027)
2. Higher Secondary Certificate (HSC) - 90% - Jai Saradha Matriculation Higher Secondary School, Tirupur, India (2022 - 2023)
`.trim();

const fs = require('fs');

// Configurable so a platform's persistent volume can be mounted at a clean
// path (e.g. /app/data) without shadowing the application code itself.
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'data.sqlite');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS resume (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    content TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS chat_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed the resume row once.
const existing = db.prepare('SELECT id FROM resume WHERE id = 1').get();
if (!existing) {
  db.prepare('INSERT INTO resume (id, content) VALUES (1, ?)').run(DEFAULT_RESUME);
}

function getResume() {
  const row = db.prepare('SELECT content FROM resume WHERE id = 1').get();
  return row ? row.content : DEFAULT_RESUME;
}

function setResume(content) {
  db.prepare('UPDATE resume SET content = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1').run(content);
}

function createUser(email, passwordHash) {
  db.prepare('INSERT INTO users (email, password_hash) VALUES (?, ?)').run(email, passwordHash);
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

function findUserByEmail(email) {
  return db.prepare('SELECT * FROM users WHERE email = ?').get(email);
}

// Splits the resume into labeled chunks (SUMMARY, TECHNICAL SKILLS, EXPERIENCE, ...)
// so the chat route can retrieve only the sections relevant to a question
// instead of stuffing the entire resume into every prompt.
function logChat(email, question, answer) {
  try { db.prepare('INSERT INTO chat_logs (email, question, answer) VALUES (?, ?, ?)').run(email, question, answer); } catch (e) { console.error('logChat failed', e.message); }
}

function chunkResume(resumeText) {
  const headerRe = /^(NAME|CONTACT|TITLE|SUMMARY|TECHNICAL SKILLS|EXPERIENCE|PROJECTS|EDUCATION):/gm;
  const indices = [];
  let match;
  while ((match = headerRe.exec(resumeText)) !== null) {
    indices.push({ label: match[1], start: match.index });
  }
  const parts = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i].start;
    const end = i + 1 < indices.length ? indices[i + 1].start : resumeText.length;
    parts.push({ label: indices[i].label, content: resumeText.slice(start, end).trim() });
  }
  return parts.length ? parts : [{ label: 'RESUME', content: resumeText }];
}

// Very small keyword-overlap retriever (no embeddings/vector DB needed for
// a single short document). Always includes NAME/CONTACT/TITLE/SUMMARY for
// grounding, then scores the remaining chunks against the question and
// keeps the top matches.
function retrieveRelevantChunks(resumeText, question, topK = 3) {
  const chunks = chunkResume(resumeText);
  const alwaysInclude = chunks.filter(c => ['NAME', 'CONTACT', 'TITLE', 'SUMMARY'].includes(c.label));
  const scorable = chunks.filter(c => !['NAME', 'CONTACT', 'TITLE'].includes(c.label));

  const qWords = new Set(
    question.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2)
  );

  const scored = scorable.map(chunk => {
    const chunkWords = chunk.content.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    let score = 0;
    for (const w of chunkWords) if (qWords.has(w)) score += 1;
    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const topMatches = scored.filter(s => s.score > 0).slice(0, topK).map(s => s.chunk);

  // If nothing scored (vague question like "tell me about him"), fall back
  // to including everything so the answer still has full context.
  const selected = topMatches.length ? topMatches : scorable;

  const merged = [...alwaysInclude];
  for (const c of selected) if (!merged.includes(c)) merged.push(c);
  return merged.map(c => c.content).join('\n\n');
}

module.exports = { db, getResume, setResume, createUser, findUserByEmail, logChat, retrieveRelevantChunks, DEFAULT_RESUME };
