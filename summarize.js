const crypto = require('crypto');
const sdk = require('@anthropic-ai/sdk');
const Anthropic = sdk.Anthropic || sdk.default || sdk;

const MODEL = process.env.CLAUDE_MODEL || 'claude-haiku-5-5';
const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const LEVELS = {
  simple: 'SIMPLE: use plain, everyday words a 12-year-old could follow. Short sentences, no literary jargon.',
  standard: 'STANDARD: write clearly for a general adult reader. Explain what is really going on and why it matters in the scene.',
  deep: 'DEEP: give the key idea plus the subtext — irony, implications, character motives, and why it matters to the larger work so far.',
};

const SYSTEM = (level) => `You help readers understand the books they are reading.
For each paragraph you are given, write ONE explanation of what it means — not a retelling of what it says.
Each explanation: 1-2 sentences, at most 35 words.
Style — ${LEVELS[level]}
Rules:
- Never start with "This paragraph".
- Do not invent plot events. Do not spoil or hint at anything beyond the text you are given.
- Paragraphs marked as context are for understanding only; do not summarize them.
- Reply with ONLY a JSON array of strings, one per numbered paragraph, in the same order. No other text.`;

// ponytail: unbounded in-memory cache, swap for an LRU if memory ever matters
const cache = new Map();
const key = (level, p) => crypto.createHash('sha1').update(level + p).digest('hex');

function parseArray(text, n) {
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('No JSON array in model reply');
  const arr = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(arr)) throw new Error('Model reply is not an array');
  return Array.from({ length: n }, (_, i) => (typeof arr[i] === 'string' ? arr[i].trim() : ''));
}

const demo = (p, level) =>
  `[Demo mode] (${level}) A real ${level} explanation of “${p.split(/\s+/).slice(0, 8).join(' ')}…” appears here once an API key is set.`;

async function summarize({ title, context, paragraphs, level }) {
  if (!client) return { summaries: paragraphs.map((p) => demo(p, level)), mock: true };

  const keys = paragraphs.map((p) => key(level, p));
  const todo = paragraphs.map((p, i) => i).filter((i) => !cache.has(keys[i]));
  if (todo.length) {
    const user =
      `Book: "${title}"\n\n` +
      (context ? `<context>(context only, don't summarize)\n${context}\n</context>\n\n` : '') +
      `Explain each of these ${todo.length} paragraphs:\n` +
      todo.map((i, n) => `<p id="${n + 1}">${paragraphs[i]}</p>`).join('\n');
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 200 * todo.length,
      system: SYSTEM(level),
      messages: [{ role: 'user', content: user }],
    });
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    parseArray(text, todo.length).forEach((s, n) => s && cache.set(keys[todo[n]], s));
  }
  return { summaries: keys.map((k) => cache.get(k) || ''), mock: false };
}

module.exports = { summarize, parseArray, LEVELS, MODEL, demoMode: !client };
