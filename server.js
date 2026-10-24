require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const { parseEpub, parseText } = require('./parse');
const { summarize, LEVELS, MODEL, demoMode } = require('./summarize');

const PORT = process.env.PORT || 4500;
const MAX_PARAGRAPHS = 10;
const MAX_CHARS = 3000;

const app = express();
app.set('trust proxy', 1); // behind ngrok / one hosting proxy
app.use(express.json({ limit: '200kb' })); // 10 x 3,000 chars + context, multibyte-safe
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.type('text').send('ok'));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

async function parseBook(buf, filename) {
  const ext = path.extname(filename).toLowerCase();
  const fallback = path.basename(filename, ext) || 'Untitled';
  if (ext === '.epub') return parseEpub(buf, fallback);
  if (ext === '.txt' || ext === '.md') return parseText(buf.toString('utf8'), fallback);
  throw Object.assign(new Error('Unsupported file type. Use .epub, .txt or .md'), { status: 400 });
}

app.post('/api/book', upload.single('book'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded (field "book")' });
  try {
    res.json(await parseBook(req.file.buffer, req.file.originalname));
  } catch (e) {
    res.status(e.status || 422).json({ error: e.message || 'Could not read this book' });
  }
});

const SAMPLE = path.join(__dirname, 'samples', 'pride-and-prejudice.txt');
app.get('/api/sample', (req, res) => {
  res.json(parseText(fs.readFileSync(SAMPLE, 'utf8'), 'Pride and Prejudice'));
});

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a few minutes.' },
});

app.post('/api/summaries', limiter, async (req, res) => {
  const { title = '', context = '', paragraphs, level = 'standard' } = req.body || {};
  const bad = (error) => res.status(400).json({ error });
  if (!Array.isArray(paragraphs) || !paragraphs.length) return bad('paragraphs must be a non-empty array');
  if (paragraphs.length > MAX_PARAGRAPHS) return bad(`At most ${MAX_PARAGRAPHS} paragraphs per request`);
  if (paragraphs.some((p) => typeof p !== 'string' || !p.trim() || p.length > MAX_CHARS))
    return bad(`Each paragraph must be a non-empty string of at most ${MAX_CHARS} characters`);
  if (typeof title !== 'string' || title.length > 300) return bad('Invalid title');
  if (typeof context !== 'string' || context.length > 2 * MAX_CHARS) return bad('Invalid context');
  if (!Object.hasOwn(LEVELS, level)) return bad('level must be simple, standard or deep');
  try {
    res.json(await summarize({ title, context, paragraphs, level }));
  } catch (e) {
    console.error('summaries failed:', e.message);
    res.status(502).json({ error: 'Could not get summaries right now' });
  }
});

// multer size errors and malformed JSON land here
app.use((err, req, res, next) => {
  const tooBig = err.code === 'LIMIT_FILE_SIZE';
  const status = tooBig ? 413 : err instanceof multer.MulterError ? 400 : err.status || 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: tooBig ? 'File too large (max 50 MB)' : status === 500 ? 'Server error' : err.message });
});

app.listen(PORT, () => {
  console.log(`AI Reader on http://localhost:${PORT} — model ${MODEL}${demoMode ? ' (DEMO MODE: no ANTHROPIC_API_KEY)' : ''}`);
});
