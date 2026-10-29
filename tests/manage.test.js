'use strict';

// The file-editing logic behind the test manager (manage.js): building stored
// questions from the editor form, and changing batch files, manifests and registries.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadManage, loadApp, readJson } = require('./load-app');

const m = loadManage();
// Objects made inside the sandbox have their own Object.prototype, so compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

const form = (over = {}) => ({
  id: 'X-D2-001',
  domainKey: 'D2',
  subtopic: ' Hashing ',
  objective: '',
  stem: '  What does a hash provide?\nPick one.  ',
  options: [
    { text: 'Integrity', why: '' },
    { text: 'Confidentiality', why: 'Hashes are not reversible encryption.' },
    { text: 'Availability', why: '' },
  ],
  answer: 0,
  explanation: 'A hash detects changes.',
  ...over,
});

const exam = { id: 'x', domains: [{ key: 'D1', name: 'One', weight: 1 }, { key: 'D2', name: 'Security', weight: 1 }] };

/* ---------- Building questions ---------- */

test('toRawQuestion writes the canonical format and passes validation', () => {
  const raw = m.toRawQuestion(form(), {}, 'Security');
  assert.deepEqual(plain(raw), {
    id: 'X-D2-001',
    domain: 'Domain 2: Security',
    subtopic: 'Hashing',
    scenario_stem: 'What does a hash provide?\nPick one.',
    options: { A: 'Integrity', B: 'Confidentiality', C: 'Availability' },
    correct_option: 'A',
    explanation: { correct: 'A hash detects changes.', distractors: { B: 'Hashes are not reversible encryption.' } },
  });
  const q = m.normalize(raw, 'f.json', 0);
  assert.equal(q.domainKey, 'D2');
  assert.equal(q.answer, 'A');
});

test('toRawQuestion replaces alternative field names and keeps unknown fields', () => {
  const existing = {
    id: 'X-D2-001', domain: 'Domain 2 - Sec', topic: 'Old', question: 'Old?', options: ['a', 'b'],
    answer: 'b', explanation: 'plain', difficulty: 'hard', source_ref: 7,
  };
  const raw = m.toRawQuestion(form({ objective: '2.1' }), existing, 'Security');
  for (const k of ['topic', 'question', 'stem', 'answer']) assert.ok(!(k in raw), k);
  assert.equal(raw.domain, 'Domain 2 - Sec', 'existing domain wording kept when it still matches');
  assert.equal(raw.objective, '2.1');
  assert.equal(raw.difficulty, 'hard');
  assert.equal(raw.source_ref, 7);
});

test('toRawQuestion rewrites the domain when it moves', () => {
  const raw = m.toRawQuestion(form({ id: 'f.json#3', domainKey: 'D1' }), { domain: 'Domain 2: Security' }, 'One');
  assert.equal(raw.domain, 'Domain 1: One');
  assert.equal(m.normalize(raw, 'f.json', 2).domainKey, 'D1');
});

test('toRawQuestion leaves out an empty explanation', () => {
  const raw = m.toRawQuestion(form({ explanation: ' ', options: [{ text: 'a', why: '' }, { text: 'b', why: '' }] }), {}, 'S');
  assert.ok(!('explanation' in raw));
});

test('validateQuestion reports what is missing', () => {
  assert.equal(m.validateQuestion(form(), exam, []), '');
  assert.match(m.validateQuestion(form({ stem: ' ' }), exam, []), /question text/);
  assert.match(m.validateQuestion(form({ options: [{ text: 'a', why: '' }] }), exam, []), /at least 2/);
  assert.match(m.validateQuestion(form({ options: [{ text: 'a', why: '' }, { text: ' ', why: '' }] }), exam, []), /Option B is empty/);
  assert.match(m.validateQuestion(form({ answer: -1 }), exam, []), /correct answer/);
  assert.equal(m.validateQuestion(form({ id: null }), exam, ['X-D2-001']), '');
});

test('validateQuestion rejects unknown domains, repeated options and overlong text', () => {
  const opts = (...texts) => texts.map((text) => ({ text, why: '' }));
  const L = m.LIMITS;
  assert.match(m.validateQuestion(form({ domainKey: 'D9', id: 'X-D9-001' }), exam, []), /D9 isn't registered/);
  assert.match(m.validateQuestion(form({ options: opts('Same', 'other', ' same ') }), exam, []), /Options A and C are the same/);
  assert.match(m.validateQuestion(form({ options: opts(...'ABCDEFGHIJK') }), exam, []), /at most 10/);
  assert.match(m.validateQuestion(form({ stem: 'x'.repeat(L.stem + 1) }), exam, []), /question is too long/);
  assert.match(m.validateQuestion(form({ subtopic: 'x'.repeat(L.subtopic + 1) }), exam, []), /subtopic is too long/);
  assert.match(m.validateQuestion(form({ objective: 'x'.repeat(L.objective + 1) }), exam, []), /objective is too long/);
  assert.match(m.validateQuestion(form({ explanation: 'x'.repeat(L.explanation + 1) }), exam, []), /explanation is too long/);
  assert.match(m.validateQuestion(form({ options: opts('a', 'x'.repeat(L.option + 1)) }), exam, []), /Option B is too long/);
  const notes = form();
  notes.options[1].why = 'x'.repeat(L.note + 1);
  assert.match(m.validateQuestion(notes, exam, []), /note for option B is too long/);
  // The correct option's note is never saved, so it isn't checked.
  notes.options[1].why = '';
  notes.options[0].why = 'x'.repeat(L.note + 1);
  assert.equal(m.validateQuestion(notes, exam, []), '');
  // Limits count trimmed text.
  assert.equal(m.validateQuestion(form({ stem: ` ${'x'.repeat(L.stem)} ` }), exam, []), '');
});

test('nextQuestionId continues the numbering for that domain', () => {
  assert.equal(m.nextQuestionId('cloud-sample', 'D2', []), 'CLOUD-SAMPLE-D2-001');
  assert.equal(m.nextQuestionId('sample', 'D1', ['SAMPLE-D1-001', 'SAMPLE-D1-009', 'SAMPLE-D2-020']), 'SAMPLE-D1-010');
  // A prefix that already looks like a domain would put the question in the wrong one.
  const id = m.nextQuestionId('x-d3-y', 'D1', []);
  assert.equal(m.domainKeyFor({}, id), 'D1');
});

test('slugify makes a file-safe id', () => {
  assert.equal(m.slugify('  Cloud Essentials (Sample) '), 'cloud-essentials-sample');
  assert.equal(m.slugify('Café Ñetworks!'), 'cafe-networks');
  assert.equal(m.slugify('***'), '');
});

/* ---------- Batch files ---------- */

test('upsertQuestion replaces by id and keeps the file shape', () => {
  const arr = [{ id: 'A' }, { id: 'B' }];
  assert.deepEqual(plain(m.upsertQuestion(arr, { id: 'B', x: 1 }, 'B', 'f.json')), [{ id: 'A' }, { id: 'B', x: 1 }]);
  const wrapped = { meta: 1, questions: [{ id: 'A' }] };
  assert.deepEqual(plain(m.upsertQuestion(wrapped, { id: 'C' }, null, 'f.json')), { meta: 1, questions: [{ id: 'A' }, { id: 'C' }] });
  assert.deepEqual(plain(arr), [{ id: 'A' }, { id: 'B' }], 'input untouched');
  assert.throws(() => m.upsertQuestion(arr, { id: 'Z' }, 'Z', 'f.json'), /no longer in f.json/);
});

test('questions without an id are found by their file position', () => {
  const arr = [{ id: 'A' }, { scenario_stem: 'no id' }];
  assert.equal(m.findQuestion(arr, 'f.json#2', 'f.json'), 1);
  assert.equal(m.findQuestion(arr, 'f.json#1', 'f.json'), -1, 'position 1 has its own id');
  assert.deepEqual(plain(m.removeQuestion(arr, 'f.json#2', 'f.json')), [{ id: 'A' }]);
});

test('updateManifestCounts updates counts and lists a new batch', () => {
  const manifest = { manifest_version: '1.0', total_questions: 2, batches: [{ batch_id: 'v1', file_name: 'v1.json', item_count: 2, covered_subtopics: ['x'] }], extra: true };
  const edited = plain(m.updateManifestCounts(manifest, 'v1.json', 1, 1));
  assert.deepEqual(edited.batches, [{ batch_id: 'v1', file_name: 'v1.json', item_count: 1, covered_subtopics: ['x'] }]);
  assert.equal(edited.total_questions, 1);
  assert.equal(edited.extra, true);
  const added = plain(m.updateManifestCounts(manifest, 'x_added.json', 1, 3));
  assert.deepEqual(added.batches[1], { batch_id: 'x_added', file_name: 'x_added.json', item_count: 1 });
  assert.ok(!('total_questions' in plain(m.updateManifestCounts({ batches: [] }, 'a.json', 1, 1))));
});

test('countQuestions counts distinct valid ids across batches', () => {
  const good = (id) => ({ id, scenario_stem: 'Q', options: { A: 'a', B: 'b' }, correct_option: 'A' });
  assert.equal(m.countQuestions([
    { file: 'a.json', data: [good('X-D1-1'), good('X-D1-2'), { id: 'bad' }] },
    { file: 'b.json', data: { questions: [good('X-D1-2')] } },
  ]), 2);
});

test('addedBatchName sits next to the manifest', () => {
  assert.equal(m.addedBatchName('samples/sample_manifest.json'), 'sample_added.json');
  assert.equal(m.addedBatchName('manifest.json'), 'questions_added.json');
});

/* ---------- New tests ---------- */

const newTest = (over = {}) => ({
  name: 'Net Basics', title: '', id: 'net-basics', shared: false,
  domains: [{ name: 'Routing', weight: '60' }, { name: 'Switching', weight: 40 }],
  ...over,
});

test('validateNewTest checks name, id and domains', () => {
  assert.equal(m.validateNewTest(newTest(), []), '');
  assert.match(m.validateNewTest(newTest({ name: ' ' }), []), /name/);
  assert.match(m.validateNewTest(newTest({ id: 'Bad Id' }), []), /lowercase/);
  assert.match(m.validateNewTest(newTest(), [{ id: 'net-basics' }]), /already exists/);
  assert.match(m.validateNewTest(newTest({ domains: [] }), []), /at least one/);
  assert.match(m.validateNewTest(newTest({ domains: [{ name: 'A', weight: 0 }] }), []), /weight/);
});

test('validateNewTest rejects bad weights, repeated domains and overlong fields', () => {
  const L = m.LIMITS;
  for (const weight of ['', ' ', 'abc', 'Infinity', '-1', 0, L.weight + 1, NaN, null]) {
    assert.match(m.validateNewTest(newTest({ domains: [{ name: 'A', weight }] }), []), /weight above 0/, `weight ${weight}`);
  }
  for (const weight of ['0.5', ' 7 ', L.weight, 1]) {
    assert.equal(m.validateNewTest(newTest({ domains: [{ name: 'A', weight }] }), []), '', `weight ${weight}`);
  }
  assert.match(m.validateNewTest(newTest({ domains: [{ name: 'Net', weight: 1 }, { name: ' net ', weight: 1 }] }), []), /Two domains/);
  assert.match(m.validateNewTest(newTest({ domains: Array.from({ length: L.domains + 1 }, (_, i) => ({ name: `d${i}`, weight: 1 })) }), []), /at most/);
  assert.match(m.validateNewTest(newTest({ id: '' }), []), /Enter an id/);
  assert.match(m.validateNewTest(newTest({ id: '-net' }), []), /start with a letter/);
  assert.match(m.validateNewTest(newTest({ id: 'a'.repeat(L.id + 1) }), []), /id is too long/);
  assert.match(m.validateNewTest(newTest({ name: 'n'.repeat(L.name + 1) }), []), /name is too long/);
  assert.match(m.validateNewTest(newTest({ title: 't'.repeat(L.title + 1) }), []), /title is too long/);
  assert.match(m.validateNewTest(newTest({ domains: [{ name: 'd'.repeat(L.domainName + 1), weight: 1 }] }), []), /D1's name is too long/);
});

test('newExamFiles builds a private test that the app accepts', () => {
  const { exam, files } = m.newExamFiles(newTest({ title: ' Net Practice ' }), null);
  assert.deepEqual(plain(files.map((f) => f.path)), ['exams.local.json', 'private/net-basics_manifest.json', 'private/net-basics_added.json']);
  assert.deepEqual(plain(exam), {
    id: 'net-basics', name: 'Net Basics', title: 'Net Practice', manifest: 'private/net-basics_manifest.json',
    domains: [{ key: 'D1', name: 'Routing', weight: 60 }, { key: 'D2', name: 'Switching', weight: 40 }],
  });
  const app = loadApp();
  assert.equal(app.examList(files[0].data).length, 1);
  assert.deepEqual(plain(files[1].data.batches), [{ batch_id: 'net-basics_added', file_name: 'net-basics_added.json', item_count: 0 }]);
  assert.deepEqual(plain(files[2].data), []);
});

test('newExamFiles appends to the shared registry in its existing shape', () => {
  const registry = readJson('exams.json');
  const { files } = m.newExamFiles(newTest({ shared: true }), registry);
  assert.equal(files[0].path, 'exams.json');
  assert.equal(files[1].path, 'samples/net-basics_manifest.json');
  const ids = plain(files[0].data.exams.map((e) => e.id));
  assert.deepEqual(ids, [...registry.exams.map((e) => e.id), 'net-basics']);
  assert.ok(!('title' in files[0].data.exams.at(-1)));
  assert.equal(plain(m.newExamFiles(newTest(), [{ id: 'a' }]).files[0].data).length, 2, 'bare-array registry stays an array');
});

/* ---------- Uploading batches ---------- */

const sampleExam = () => readJson('exams.json').exams.find((e) => e.id === 'sample');

test('uploadTemplate is a valid batch for the test it was made for', () => {
  const ex = sampleExam();
  const ids = ['SAMPLE-D1-001', 'SAMPLE-D1-002'];
  const template = plain(m.uploadTemplate(ex, ids));
  assert.equal(template.length, 4);
  assert.deepEqual(template.map((q) => q.id), ['SAMPLE-D1-003', 'SAMPLE-D2-001', 'SAMPLE-D3-001', 'SAMPLE-D4-001']);
  const result = plain(m.checkUpload(template, ex, ids, 'append'));
  assert.equal(result.questions.length, 4);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(template.map((q) => m.normalize(q, 'f', 0).domainKey), ['D1', 'D2', 'D3', 'D4']);
});

test('checkUpload skips invalid, unknown-domain and duplicate questions', () => {
  const [good] = plain(m.uploadTemplate(exam));
  const data = [
    good,
    { ...good },                                                   // same id again
    { ...good, id: 'X-D9-001' },                                   // unknown domain
    { ...good, id: 'X-D1-050', correct_option: 'Z' },              // answer not an option
    { ...good, id: 'X-D1-051', options: { A: 'only one' }, correct_option: 'A' },
    'not a question',
    { ...good, id: 'X-D1-052' },
  ];
  const r = plain(m.checkUpload(data, exam, [], 'append'));
  assert.deepEqual(r.questions.map((q) => q.id), [good.id, 'X-D1-052']);
  assert.equal(r.skipped.length, 5);
  assert.match(r.skipped[0], /^#2 .*earlier in the file/);
  assert.match(r.skipped[1], /D9/);
  assert.match(r.skipped[4], /^#6: not a question/);
});

test('checkUpload skips ids already in the bank only when appending', () => {
  const [good] = plain(m.uploadTemplate(exam));
  assert.match(plain(m.checkUpload([good], exam, [good.id], 'append')).skipped[0], /already in the bank/);
  assert.equal(plain(m.checkUpload([good], exam, [good.id], 'replace')).questions.length, 1);
});

test('checkUpload gives questions without an id the next free one from their domain', () => {
  const { id, ...noId } = plain(m.uploadTemplate(exam))[0];
  const data = [{ ...noId, domain: 'Domain 2: Security' }, { ...noId, id: '', domain: 'Domain 2' }, { ...noId, domain: 'Other' }];
  const r = plain(m.checkUpload(data, exam, ['X-D2-001'], 'append'));
  assert.deepEqual(r.questions.map((q) => q.id), ['X-D2-002', 'X-D2-003']);
  assert.equal(Object.keys(r.questions[0])[0], 'id', 'id comes first');
  assert.match(r.skipped[0], /^#3: no id/);
});

test('checkUpload accepts { questions } files and rejects other shapes', () => {
  const t = plain(m.uploadTemplate(exam));
  assert.equal(plain(m.checkUpload({ batch_id: 'b', questions: t }, exam, [], 'append')).questions.length, 2);
  for (const bad of [{}, 'x', null, 7, { questions: 'no' }]) assert.match(m.checkUpload(bad, exam, [], 'append').error, /JSON array/);
  assert.match(m.checkUpload([], exam, [], 'append').error, /no questions/);
});

test('uploadBatchName keeps the file name safe and unique', () => {
  assert.equal(m.uploadBatchName('Batch V7.json', []), 'batch_v7.json');
  assert.equal(m.uploadBatchName('batch_v7.JSON', ['batch_v7.json', 'batch_v7_2.json']), 'batch_v7_3.json');
  assert.equal(m.uploadBatchName('../..\evil<>.json', []), 'evil.json');
  assert.equal(m.uploadBatchName('...', []), 'upload.json');
  assert.equal(m.uploadBatchName('CON.json', []), 'upload_con.json');
  assert.equal(m.uploadBatchName('x'.repeat(200), []).length, 65);
});

test('uploadManifest appends a batch or replaces them all, keeping other fields', () => {
  const manifest = readJson('samples/sample_manifest.json');
  const appended = plain(m.uploadManifest(manifest, 'new.json', 5, 'append', 25));
  assert.deepEqual(appended.batches.map((b) => b.file_name), ['sample_bank_v1.json', 'sample_bank_v2.json', 'new.json']);
  assert.equal(appended.total_questions, 25);
  assert.deepEqual(appended.target_subtopics_for_next_batches, manifest.target_subtopics_for_next_batches);

  const replaced = plain(m.uploadManifest(manifest, 'new.json', 5, 'replace', 25));
  assert.deepEqual(replaced.batches, [{ batch_id: 'new', file_name: 'new.json', item_count: 5 }]);
  assert.equal(replaced.total_questions, 5);
  assert.equal(replaced.manifest_version, '1.0');
});
