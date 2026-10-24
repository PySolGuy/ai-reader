const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const MIN_WORDS = 20;
const BATCH = 6;
const MAX_CHARS = 3000;
const SHIM = '<span class="shim"></span><span class="shim"></span>';

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};

const defaults = { summaries: true, level: 'standard', fs: 19, theme: null, pos: 0 };
let book = null, bookKey = '', state = { ...defaults };
let flat = []; // every paragraph in reading order: { text, el, sum, status }
const cache = new Map(); // `${level}|${index}` -> summary, so depth toggling back is free
const queue = new Set();
let flushTimer = null, saveTimer = null;

const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) request(+e.target.dataset.gi);
}, { rootMargin: '800px 0px' });

/* ---------- settings ---------- */

function applySettings() {
  root.style.setProperty('--fs', state.fs + 'px');
  if (state.theme) root.dataset.theme = state.theme; else delete root.dataset.theme;
  document.body.classList.toggle('nosum', !state.summaries);
  $('sumToggle').checked = state.summaries;
  $('level').value = state.level;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.set('air:' + bookKey, state), 300);
}

function change(patch) {
  const keepPos = state.pos;
  Object.assign(state, patch);
  applySettings();
  save();
  if ('fs' in patch) flat[keepPos]?.el.scrollIntoView({ block: 'start' });
  if ('level' in patch || ('summaries' in patch && patch.summaries)) rewatch();
}

/* ---------- opening books ---------- */

function setStatus(msg, isError) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', !!isError);
}

async function loadSample() {
  setStatus('Opening sample…');
  try {
    const r = await fetch('/api/sample');
    if (!r.ok) throw new Error('Could not load the sample book');
    openBook(await r.json(), { sample: true });
  } catch (e) { setStatus(e.message, true); }
}

async function upload(file) {
  if (!file) return;
  if (!/\.(epub|txt|md)$/i.test(file.name)) return setStatus('Please choose an .epub, .txt or .md file.', true);
  showLanding();
  setStatus(`Reading “${file.name}”…`);
  const fd = new FormData();
  fd.append('book', file);
  try {
    const r = await fetch('/api/book', { method: 'POST', body: fd });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not read this book');
    openBook(data, { book: data });
  } catch (e) { setStatus(e.message, true); }
}

function openBook(b, source) {
  book = b;
  bookKey = b.title + '|' + b.chapters.reduce((n, c) => n + c.paragraphs.length, 0);
  state = { ...defaults, ...store.get('air:' + bookKey, {}) };
  // remember what to reopen on reload; big books may not fit in localStorage
  if (!store.set('air:current', source)) store.set('air:current', null);

  io.disconnect();
  queue.clear();
  flat = [];
  const reader = $('reader'), toc = $('toc');
  reader.textContent = '';
  toc.textContent = '';
  const frag = document.createDocumentFragment();
  b.chapters.forEach((c, ci) => {
    const h = document.createElement('h2');
    h.id = 'ch-' + ci;
    h.textContent = c.title;
    frag.append(h);
    const li = document.createElement('li'), a = document.createElement('a');
    a.href = '#ch-' + ci;
    a.textContent = c.title;
    a.dataset.gi = flat.length;
    a.onclick = (e) => { e.preventDefault(); closeDrawer(); h.scrollIntoView({ block: 'start' }); };
    li.append(a);
    toc.append(li);

    for (const text of c.paragraphs) {
      const gi = flat.length;
      const p = document.createElement('p');
      p.textContent = text;
      p.dataset.gi = gi;
      frag.append(p);
      const item = { text, el: p, sum: null, status: '' };
      if (text.split(/\s+/).length >= MIN_WORDS) {
        item.sum = document.createElement('div');
        item.sum.className = 'sum';
        item.sum.innerHTML = SHIM;
        item.sum.dataset.gi = gi;
        item.sum.setAttribute('aria-live', 'polite');
        frag.append(item.sum);
      }
      flat.push(item);
    }
  });
  reader.append(frag);

  document.title = b.title + ' · AI Reader';
  $('bookTitle').textContent = b.title;
  $('landing').hidden = true;
  reader.hidden = false;
  for (const id of ['menuBtn', 'settingsBtn', 'controls']) $(id).hidden = false;
  setStatus('');
  applySettings();

  const restore = () => {
    const target = flat[state.pos];
    if (target && state.pos > 0) target.el.scrollIntoView({ block: 'start' });
    else window.scrollTo(0, 0);
  };
  restore();
  document.fonts?.ready.then(restore); // web fonts reflow the text after first paint
  rewatch();
  onScroll();
}

function showLanding() {
  closeDrawer();
  $('landing').hidden = false;
  $('reader').hidden = true;
  for (const id of ['menuBtn', 'settingsBtn', 'controls']) $(id).hidden = true;
  $('bookTitle').textContent = 'AI Reader';
  document.title = 'AI Reader';
  $('progressBar').style.width = '0';
  io.disconnect();
}

/* ---------- summaries ---------- */

function rewatch() {
  io.disconnect();
  for (const it of flat) {
    if (!it.sum) continue;
    it.status = ''; // in-flight replies for an old level/book are dropped in fetchBatch
    io.observe(it.el);
  }
}

function request(gi) {
  const it = flat[gi];
  if (!state.summaries || !it?.sum || it.status) return;
  const cached = cache.get(state.level + '|' + gi);
  if (cached) return show(it, cached);
  it.status = 'loading';
  it.sum.innerHTML = SHIM;
  queue.add(gi);
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 60);
}

function flush() {
  const ids = [...queue].sort((a, b) => a - b);
  queue.clear();
  for (let i = 0; i < ids.length; i += BATCH) fetchBatch(ids.slice(i, i + BATCH));
}

async function fetchBatch(ids) {
  const level = state.level, mine = flat;
  const current = () => mine === flat && level === state.level;
  const context = flat.slice(Math.max(0, ids[0] - 2), ids[0]).map((x) => x.text.slice(0, MAX_CHARS)).join('\n\n');
  try {
    const r = await fetch('/api/summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: book.title, context, level, paragraphs: ids.map((g) => mine[g].text.slice(0, MAX_CHARS)) }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(r.status === 429 ? 'Slow down a moment.' : data.error || 'Request failed.');
    if (data.mock) $('demoBanner').hidden = false;
    ids.forEach((g, n) => {
      const s = data.summaries?.[n];
      if (s) cache.set(level + '|' + g, s);
      if (current()) s ? show(mine[g], s) : fail(mine[g], g);
    });
  } catch (e) {
    if (current()) ids.forEach((g) => fail(mine[g], g, e.message));
  }
}

function show(it, text) {
  it.status = 'done';
  it.sum.textContent = text;
}

function fail(it, gi, msg = '') {
  it.status = 'error';
  it.sum.textContent = `Couldn't load this explanation. ${msg} `;
  const a = document.createElement('a');
  a.textContent = 'Retry';
  a.setAttribute('role', 'button');
  a.tabIndex = 0;
  a.onclick = a.onkeydown = (e) => {
    if (e.type === 'keydown' && e.key !== 'Enter') return;
    it.status = '';
    request(gi);
  };
  it.sum.append(a);
}

/* ---------- scrolling: progress + position ---------- */

let ticking = false;
function onScroll() {
  if (ticking || $('reader').hidden) return;
  ticking = true;
  requestAnimationFrame(() => {
    ticking = false;
    const max = root.scrollHeight - innerHeight;
    $('progressBar').style.width = (max > 0 ? (scrollY / max) * 100 : 0) + '%';
    const el = document.elementFromPoint(innerWidth / 2, 72)?.closest('[data-gi]');
    if (el && !el.closest('#toc') && +el.dataset.gi !== state.pos) {
      state.pos = +el.dataset.gi;
      save();
    }
  });
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);

/* ---------- drawer + controls ---------- */

function openDrawer() {
  const links = [...$('toc').querySelectorAll('a')];
  let cur = links[0];
  for (const a of links) if (+a.dataset.gi <= state.pos) cur = a;
  links.forEach((a) => a.classList.toggle('current', a === cur));
  $('drawer').classList.add('open');
  $('scrim').hidden = false;
  cur?.scrollIntoView({ block: 'center' });
}
function closeDrawer() {
  $('drawer').classList.remove('open');
  $('scrim').hidden = true;
}

$('menuBtn').onclick = openDrawer;
$('closeDrawer').onclick = closeDrawer;
$('scrim').onclick = closeDrawer;
addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());
$('openOther').onclick = () => { store.set('air:current', null); showLanding(); };

$('settingsBtn').onclick = (e) => {
  e.stopPropagation();
  const open = $('controls').classList.toggle('open');
  $('settingsBtn').setAttribute('aria-expanded', open);
};
document.addEventListener('click', (e) => {
  if (!e.target.closest('#controls')) { $('controls').classList.remove('open'); $('settingsBtn').setAttribute('aria-expanded', false); }
});

$('sumToggle').onchange = (e) => change({ summaries: e.target.checked });
$('level').onchange = (e) => change({ level: e.target.value });
$('smaller').onclick = () => change({ fs: Math.max(14, state.fs - 1) });
$('bigger').onclick = () => change({ fs: Math.min(30, state.fs + 1) });
$('themeBtn').onclick = () => {
  const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  change({ theme: dark ? 'light' : 'dark' });
};

/* ---------- file picking + drag/drop ---------- */

$('file').onchange = (e) => { upload(e.target.files[0]); e.target.value = ''; };
$('sampleBtn').onclick = loadSample;
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dragging'); });
addEventListener('drop', (e) => {
  e.preventDefault();
  document.body.classList.remove('dragging');
  upload(e.dataTransfer.files[0]);
});

/* ---------- start ---------- */

const last = store.get('air:current', null);
if (last?.sample) loadSample();
else if (last?.book) openBook(last.book, last);
