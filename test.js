// Self-check for the parsers and the model-reply parser: `npm test`
const assert = require('assert');
const fs = require('fs');
const JSZip = require('jszip');
const { parseEpub, parseText } = require('./parse');
const { parseArray } = require('./summarize');

(async () => {
  const sample = parseText(fs.readFileSync(__dirname + '/samples/pride-and-prejudice.txt', 'utf8'), 'P&P');
  assert.deepStrictEqual(sample.chapters.map((c) => c.title), ['Chapter 1', 'Chapter 2', 'Chapter 3']);
  assert.ok(sample.chapters[0].paragraphs[0].startsWith('It is a truth universally acknowledged'));

  const md = parseText('Intro line\nwraps here.\n\n# One\nFirst para.\n\nCHAPTER II\n\nSecond\npara.', 'T');
  assert.deepStrictEqual(md.chapters, [
    { title: 'T', paragraphs: ['Intro line wraps here.'] },
    { title: 'One', paragraphs: ['First para.'] },
    { title: 'CHAPTER II', paragraphs: ['Second para.'] },
  ]);

  const zip = new JSZip();
  zip.file('META-INF/container.xml', '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<package><metadata><dc:title>Tom &amp; Jerry</dc:title></metadata>
    <manifest><item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml"/></manifest>
    <spine><itemref idref="c2"/><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/text/ch 1.xhtml', '<html><body><h2>First</h2><p>Hello\n   world &amp; co.</p><blockquote><p>Quoted</p></blockquote><blockquote>Bare quote</blockquote></body></html>');
  zip.file('OEBPS/text/c2.xhtml', '<html><body><h1>Second</h1><p>Comes first by spine.</p></body></html>');
  const epub = await parseEpub(await zip.generateAsync({ type: 'nodebuffer' }), 'x');
  assert.deepStrictEqual(epub, {
    title: 'Tom & Jerry',
    chapters: [
      { title: 'Second', paragraphs: ['Comes first by spine.'] },
      { title: 'First', paragraphs: ['Hello world & co.', 'Quoted', 'Bare quote'] },
    ],
  });

  assert.deepStrictEqual(parseArray('Sure!\n["a", "b"]\nDone', 3), ['a', 'b', '']);
  assert.deepStrictEqual(parseArray('["a","b","c"]', 2), ['a', 'b']);
  assert.throws(() => parseArray('no json', 1));
  console.log('all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
