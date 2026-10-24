const path = require('path');
const JSZip = require('jszip');
const { parse } = require('node-html-parser');

const clean = (s) => s.replace(/\s+/g, ' ').trim();
const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`)) || [])[1];
const decode = (s) => parse(`<b>${s}</b>`).text; // decode XML entities in OPF title

async function parseEpub(buf, fallbackTitle) {
  const zip = await JSZip.loadAsync(buf);
  const read = async (p) => {
    const f = zip.file(p);
    if (!f) throw new Error(`Missing file in EPUB: ${p}`);
    return f.async('string');
  };

  const container = await read('META-INF/container.xml');
  const opfPath = attr(container.match(/<rootfile\b[^>]*>/)?.[0] || '', 'full-path');
  if (!opfPath) throw new Error('No rootfile in container.xml');
  const opf = await read(opfPath);
  const opfDir = path.posix.dirname(opfPath);

  // ponytail: regex over the OPF instead of an XML parser; namespaced/self-closing tags trip HTML parsers
  const manifest = {};
  for (const tag of opf.match(/<(?:opf:)?item\b[^>]*>/g) || []) {
    const id = attr(tag, 'id'), href = attr(tag, 'href');
    if (id && href) manifest[id] = href;
  }
  const spine = (opf.match(/<(?:opf:)?itemref\b[^>]*>/g) || []).map((t) => attr(t, 'idref')).filter(Boolean);
  const title = clean(decode(opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)?.[1] || '')) || fallbackTitle;

  const chapters = [];
  for (const idref of spine) {
    const href = manifest[idref];
    if (!href) continue;
    const file = path.posix.normalize(path.posix.join(opfDir, decodeURIComponent(href.split('#')[0])));
    let html;
    try { html = await read(file); } catch { continue; }
    const root = parse(html);
    const paragraphs = root
      .querySelectorAll('p, blockquote')
      .filter((el) => el.tagName === 'P' || !el.querySelector('p')) // blockquotes wrapping <p> would duplicate text
      .map((el) => clean(el.text))
      .filter(Boolean);
    if (!paragraphs.length) continue;
    const heading = root.querySelector('h1, h2, h3');
    chapters.push({ title: (heading && clean(heading.text)) || `Section ${chapters.length + 1}`, paragraphs });
  }
  if (!chapters.length) throw new Error('No readable text found in EPUB');
  return { title, chapters };
}

const isHeading = (line) => line.length < 80 && (/^#/.test(line) || /^(chapter|part|book)\b/i.test(line));

function parseText(text, title) {
  const chapters = [];
  let cur = null;
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    if (isHeading(lines[0])) {
      cur = { title: clean(lines.shift().replace(/^#+/, '')) || `Chapter ${chapters.length + 1}`, paragraphs: [] };
      chapters.push(cur);
    }
    const para = clean(lines.map((l) => l.replace(/^>\s?/, '')).join(' '));
    if (!para) continue;
    if (!cur) chapters.push((cur = { title, paragraphs: [] }));
    cur.paragraphs.push(para);
  }
  const nonEmpty = chapters.filter((c) => c.paragraphs.length);
  if (!nonEmpty.length) throw new Error('No readable text found');
  return { title, chapters: nonEmpty };
}

module.exports = { parseEpub, parseText };
