# AI Reader

A web ebook reader that puts a short **"What this means"** explanation under every paragraph, written by Claude.
Open an `.epub`, `.txt` or `.md` file (or try the built-in sample — the first three chapters of *Pride and Prejudice*)
and read with plain-language explanations at three depths: **Simple**, **Standard** or **Deep**.

- Explanations load lazily, only for paragraphs near the screen, in batches of 6.
- Short paragraphs (under 20 words) are skipped.
- Reader settings and your reading position are remembered per book.
- Light / dark theme (follows your system by default), adjustable text size, chapter menu, progress bar.
- Without an API key the app runs in **demo mode** and shows placeholder explanations.

## Run locally

Requires Node.js 20+.

```bash
npm install
cp .env.example .env     # then put your key in .env: ANTHROPIC_API_KEY=sk-ant-...
npm start                # http://localhost:4500
```

`npm test` runs a quick self-check of the book parsers.

### Configuration (`.env`)

| Variable            | Default            | Notes                                                      |
| ------------------- | ------------------ | ---------------------------------------------------------- |
| `ANTHROPIC_API_KEY` | _(empty)_          | Empty = demo mode. Never commit this file.                 |
| `CLAUDE_MODEL`      | `claude-haiku-5-5` | Any Claude model ID, e.g. a Sonnet model for richer notes. |
| `PORT`              | `4500`             |                                                            |

## API

| Method | Path             | Body / response                                                                                  |
| ------ | ---------------- | ------------------------------------------------------------------------------------------------ |
| POST   | `/api/book`      | multipart field `book` (max 50 MB) → `{ title, chapters: [{ title, paragraphs: [string] }] }`  |
| GET    | `/api/sample`    | the parsed sample book, same shape                                                               |
| POST   | `/api/summaries` | `{ title, context, paragraphs: [string], level }` → `{ summaries: [string], mock: boolean }`   |
| GET    | `/health`        | `ok`                                                                                             |

`level` is `simple`, `standard` or `deep`.

### Limits (the app is meant to be public)

- `/api/summaries` is rate-limited to 60 requests per 10 minutes per IP (`429` after that).
- At most 10 paragraphs per request and 3,000 characters per paragraph (`400` otherwise).
- Summaries are cached in memory, so re-reading costs nothing until the server restarts.
- The API key stays on the server; the browser never sees it.

## Deploy / update

The app is a single Node process with no build step, so any Node host works.

**Quick share from your own machine (ngrok):**

```bash
npm start
ngrok http 4500
```

**A Node host (Render, Railway, Fly.io, a VPS…):**

1. Point the host at this repo. Build command: `npm install`. Start command: `npm start`.
2. Set the `ANTHROPIC_API_KEY` (and optionally `CLAUDE_MODEL`) environment variables in the host's dashboard.
3. The host sets `PORT` automatically. `trust proxy` is set to one hop, which is right for these hosts and ngrok.

**Update:** `git pull && npm install`, then restart the process (or push to the repo and let the host redeploy).

## Project layout

```
server.js        Express app: routes, validation, rate limit
parse.js         EPUB and TXT/MD parsers
summarize.js     Claude call, prompt, response parsing, cache, demo mode
public/          index.html, style.css, app.js (no build step)
samples/         pride-and-prejudice.txt (public domain, chapters 1-3)
test.js          parser self-check
```

## Credits

Sample text: *Pride and Prejudice* by Jane Austen (public domain, via [Project Gutenberg #1342](https://www.gutenberg.org/ebooks/1342)).
