'use strict';

// Checks on the files the repo ships: the exam registry, the sample bank, and
// the promise that the app makes no requests outside the local server.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, readJson, ROOT } = require('./load-app');

const app = loadApp();

const exams = app.examList(readJson('exams.json'));

test('exams.json registers at least one valid exam with unique ids', () => {
  assert.ok(exams.length > 0);
  assert.equal(new Set(exams.map((e) => e.id)).size, exams.length);
  for (const e of exams) {
    assert.ok(e.name, `${e.id}: name`);
    assert.ok(e.domains.length, `${e.id}: domains`);
    assert.equal(new Set(e.domains.map((d) => d.key)).size, e.domains.length, `${e.id}: duplicate domain key`);
    for (const d of e.domains) {
      assert.match(d.key, /^D\d+$/, `${e.id}: domain key ${d.key}`);
      assert.ok(d.name, `${e.id}/${d.key}: name`);
      assert.ok(Number(d.weight) > 0, `${e.id}/${d.key}: weight`);
    }
  }
});

for (const exam of exams) {
  test(`every question in the "${exam.id}" bank is valid, unique and in a known domain`, () => {
    const manifest = readJson(exam.manifest);
    const dir = path.posix.dirname(exam.manifest);
    const files = manifest.batches.map((b) => b.file_name);
    assert.ok(files.length, 'manifest lists no batches');

    const keys = new Set(exam.domains.map((d) => d.key));
    const ids = new Set();
    for (const file of files) {
      const data = readJson(path.posix.join(dir, file));
      const items = Array.isArray(data) ? data : data.questions;
      items.forEach((item, i) => {
        const n = app.normalize(item, file, i);
        assert.ok(n, `${file} #${i + 1} fails validation`);
        assert.ok(keys.has(n.domainKey), `${n.id}: unknown domain ${n.domainKey}`);
        assert.ok(!ids.has(n.id), `${n.id}: duplicate id`);
        ids.add(n.id);
        for (const k of Object.keys(n.distractors)) {
          assert.ok(n.letters.includes(k), `${n.id}: distractor note for missing option ${k}`);
        }
      });
    }
    if (manifest.total_questions != null) assert.equal(ids.size, manifest.total_questions, 'total_questions');
  });
}

test('the app references no external hosts', () => {
  // XML namespaces are identifiers, not requests.
  const allowed = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)|^http:\/\/www\.w3\.org\//;
  for (const file of ['shared.js', 'app.js', 'index.html', 'manage.js', 'manage.html', 'styles.css']) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [url] of text.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
      assert.match(url, allowed, `${file} references ${url}`);
    }
    assert.doesNotMatch(text, /@import\s+url\(\s*['"]?\/\//, `${file} imports a protocol-relative URL`);
  }
});

test('the Pages site publishes every page, script and stylesheet the pages load', () => {
  // GitHub Pages only gets the files the workflow copies, so a new file that's
  // missing from that list works locally but leaves the online site broken.
  const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/pages.yml'), 'utf8');
  const published = new Set();
  for (const [, args] of workflow.matchAll(/^\s*cp (?:-r )?(.+?) _site\/\s*$/gm)) {
    for (const name of args.trim().split(/\s+/)) published.add(name);
  }
  assert.ok(published.has('index.html'), 'pages.yml copies no index.html');
  const isPublished = (rel) => published.has(rel) || [...published].some((p) => rel.startsWith(`${p}/`));

  const pages = [...published].filter((f) => /\.(html|js)$/.test(f));
  for (const file of pages) {
    const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
    for (const [, ref] of text.matchAll(/(?:src|href)="([^"#?:]+\.(?:html|js|css))"/g)) {
      assert.ok(isPublished(ref), `${file} loads ${ref}, which pages.yml doesn't publish`);
    }
  }
});
