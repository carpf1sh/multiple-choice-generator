'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./load-app');

const app = loadApp();
// Objects made inside the sandbox have their own Object.prototype, so compare plain copies.
const plain = (v) => JSON.parse(JSON.stringify(v));

const raw = (over = {}) => ({
  id: 'X-D1-001',
  domain: 'Domain 1: Networking',
  subtopic: 'OSI',
  scenario_stem: 'Which layer?',
  options: { A: 'One', B: 'Two', C: 'Three', D: 'Four' },
  correct_option: 'B',
  explanation: { correct: 'Because.', distractors: { A: 'No A', C: 'No C', D: 'No D' } },
  ...over,
});

const q = (id, subtopic = 'General', objective = '') => ({ id, subtopic, objective, domainKey: 'D1' });

test.beforeEach(() => { app.state.history = {}; });

/* ---------- Escaping ---------- */

test('esc escapes every HTML-significant character', () => {
  assert.equal(app.esc(`<img src=x onerror="a('b')">&`), '&lt;img src=x onerror=&quot;a(&#39;b&#39;)&quot;&gt;&amp;');
  assert.equal(app.esc(null), '');
  assert.equal(app.esc(undefined), '');
  assert.equal(app.esc(42), '42');
});

/* ---------- normalize ---------- */

test('normalize maps a well-formed question to the internal shape', () => {
  const n = app.normalize(raw(), 'bank.json', 0);
  assert.deepEqual(plain(n), {
    id: 'X-D1-001',
    domainKey: 'D1',
    domainLabel: 'Domain 1: Networking',
    subtopic: 'OSI',
    objective: '',
    stem: 'Which layer?',
    options: { A: 'One', B: 'Two', C: 'Three', D: 'Four' },
    letters: ['A', 'B', 'C', 'D'],
    answer: 'B',
    explanation: 'Because.',
    distractors: { A: 'No A', C: 'No C', D: 'No D' },
    file: 'bank.json',
  });
});

test('normalize accepts the alternative field names', () => {
  const n = app.normalize({
    id: 'Y-1', domain: 'Domain 3', topic: 'Loops', question: 'Q?',
    options: ['a', 'b', 'c'], answer: 'c', explanation: 'plain text',
  }, 'f.json', 0);
  assert.equal(n.domainKey, 'D3');
  assert.equal(n.subtopic, 'Loops');
  assert.equal(n.stem, 'Q?');
  assert.deepEqual(plain(n.options), { A: 'a', B: 'b', C: 'c' });
  assert.equal(n.answer, 'C');
  assert.equal(n.explanation, 'plain text');
  assert.equal(app.normalize(raw({ stem: 'S', scenario_stem: undefined }), 'f', 0).stem, 'S');
});

test('normalize treats option keys and the answer case-insensitively', () => {
  const n = app.normalize(raw({ options: { a: 'x', ' b ': 'y' }, correct_option: ' b ' }), 'f', 0);
  assert.deepEqual(plain(n.letters), ['A', 'B']);
  assert.equal(n.answer, 'B');
});

test('normalize generates an id from the file and position when missing', () => {
  assert.equal(app.normalize(raw({ id: undefined }), 'bank.json', 4).id, 'bank.json#5');
});

test('normalize drops blank options', () => {
  const n = app.normalize(raw({ options: { A: 'x', B: 'y', C: '  ', D: null } }), 'f', 0);
  assert.deepEqual(plain(n.letters), ['A', 'B']);
});

for (const [name, over] of [
  ['no stem', { scenario_stem: '' }],
  ['no options', { options: undefined }],
  ['non-object options', { options: 'A,B' }],
  ['a single option', { options: { A: 'x' }, correct_option: 'A' }],
  ['an answer that is not an option', { correct_option: 'E' }],
  ['a missing answer', { correct_option: undefined }],
  ['a multi-letter option key', { options: { A: 'x', BB: 'y' }, correct_option: 'A' }],
  ['an option key beyond J', { options: { A: 'x', K: 'y' }, correct_option: 'A' }],
  ['an option key carrying markup', { options: { A: 'x', '"><img src=x onerror=alert(1)>': 'y' }, correct_option: 'A' }],
  ['more than ten array options', { options: Array.from({ length: 11 }, (_, i) => `o${i}`), correct_option: 'A' }],
]) {
  test(`normalize rejects a question with ${name}`, () => {
    assert.equal(app.normalize(raw(over), 'f', 0), null);
  });
}

test('normalize rejects non-objects', () => {
  for (const v of [null, undefined, 'text', 7]) assert.equal(app.normalize(v, 'f', 0), null);
});

/* ---------- domainKeyFor ---------- */

test('domainKeyFor prefers the id, then the domain label', () => {
  assert.equal(app.domainKeyFor({ domain: 'Domain 2' }, 'EX-D4-010'), 'D4');
  assert.equal(app.domainKeyFor({ domain: 'Domain 02: Security' }, 'no-key'), 'D2');
  assert.equal(app.domainKeyFor({ domain: 'Security' }, 'no-key'), null);
});

/* ---------- examList ---------- */

test('examList accepts both registry shapes and drops incomplete exams', () => {
  const good = { id: 'a', manifest: 'm.json', domains: [] };
  assert.equal(app.examList({ exams: [good] }).length, 1);
  assert.equal(app.examList([good, { id: 'b', domains: [] }, null, { id: 'c', manifest: 'm', domains: 'x' }]).length, 1);
  assert.equal(app.examList(null).length, 0);
});

/* ---------- largestRemainder / allocate ---------- */

test('largestRemainder matches the README example (50 at 30/25/25/20)', () => {
  const out = app.largestRemainder(50, [['D1', 30], ['D2', 25], ['D3', 25], ['D4', 20]]);
  assert.deepEqual(plain(out), { D1: 15, D2: 13, D3: 12, D4: 10 });
});

test('largestRemainder always sums to n', () => {
  const weights = [['a', 7], ['b', 3], ['c', 1], ['d', 13]];
  for (let n = 0; n <= 200; n++) {
    const sum = Object.values(app.largestRemainder(n, weights)).reduce((s, v) => s + v, 0);
    assert.equal(sum, n, `n=${n}`);
  }
});

test('largestRemainder returns zeros for zero weight or n', () => {
  assert.deepEqual(plain(app.largestRemainder(10, [['a', 0], ['b', 0]])), { a: 0, b: 0 });
  assert.deepEqual(plain(app.largestRemainder(0, [['a', 1]])), { a: 0 });
});

test('allocate redistributes a short domain by weight', () => {
  const r = app.allocate(20, { D1: 50, D2: 25, D3: 25 }, { D1: 4, D2: 100, D3: 100 });
  assert.deepEqual(plain(r.alloc), { D1: 4, D2: 8, D3: 8 });
  assert.equal(r.target, 20);
  assert.deepEqual(plain(r.shortfalls), [{ key: 'D1', short: 6 }]);
});

test('allocate caps the test at the bank size', () => {
  const r = app.allocate(50, { D1: 1, D2: 1 }, { D1: 3, D2: 5 });
  assert.deepEqual(plain(r.alloc), { D1: 3, D2: 5 });
  assert.equal(r.target, 8);
  assert.equal(r.capacity, 8);
});

test('allocate ignores zero-weight domains', () => {
  const r = app.allocate(5, { D1: 1, D2: 0 }, { D1: 10, D2: 10 });
  assert.deepEqual(plain(r.alloc), { D1: 5 });
});

test('allocate never exceeds availability and always fills the target', () => {
  for (let trial = 0; trial < 300; trial++) {
    const keys = ['D1', 'D2', 'D3', 'D4'];
    const weights = Object.fromEntries(keys.map((k) => [k, Math.floor(Math.random() * 40)]));
    const available = Object.fromEntries(keys.map((k) => [k, Math.floor(Math.random() * 30)]));
    const n = 1 + Math.floor(Math.random() * 200);
    const r = app.allocate(n, weights, available);
    const total = Object.values(r.alloc).reduce((s, v) => s + v, 0);
    assert.equal(total, r.target);
    for (const [k, v] of Object.entries(r.alloc)) assert.ok(v <= available[k], `${k} over capacity`);
  }
});

/* ---------- shuffleOptions ---------- */

test('shuffleOptions keeps the correct text and the explanations with their options', () => {
  const base = app.normalize(raw(), 'f', 0);
  for (let i = 0; i < 50; i++) {
    const s = app.shuffleOptions(base);
    assert.deepEqual(plain(s.letters), plain(base.letters));
    assert.equal(s.options[s.answer], 'Two');
    assert.deepEqual(Object.values(s.options).sort(), Object.values(base.options).sort());
    for (const [letter, note] of Object.entries(s.distractors)) {
      const text = s.options[letter];
      const orig = base.letters.find((L) => base.options[L] === text);
      assert.equal(base.distractors[orig], note);
    }
    assert.equal(s.source, base);
  }
});

test('shuffleOptions on a shuffled copy starts from the original', () => {
  const base = app.normalize(raw(), 'f', 0);
  const twice = app.shuffleOptions(app.shuffleOptions(base));
  assert.equal(twice.source, base);
  assert.equal(twice.options[twice.answer], 'Two');
});

test('shuffleOptions replays a given order', () => {
  const base = app.normalize(raw(), 'f', 0);
  const s = app.shuffleOptions(base, ['D', 'B', 'A', 'C']);
  assert.deepEqual(plain(s.options), { A: 'Four', B: 'Two', C: 'One', D: 'Three' });
  assert.equal(s.answer, 'B');
  assert.deepEqual(plain(s.optionOrder), ['D', 'B', 'A', 'C']);
});

/* ---------- Test history ---------- */

const finished = (questions, answers, extra = {}) => ({
  kind: 'new', questions, answers, feedback: 'end', allowSkip: true, shuffleOptions: false,
  startedAt: 1000, endedAt: 61000, ...extra,
});

test('a stored attempt restores to the same questions, answers and score', () => {
  const base = app.normalize(raw(), 'f', 0);
  const other = app.normalize(raw({ id: 'X-D1-002', correct_option: 'A' }), 'f', 1);
  app.state.questions = [base, other];
  const shuffled = app.shuffleOptions(base, ['C', 'A', 'D', 'B']);
  const rec = app.attemptRecord(finished([shuffled, other], ['D', null], { shuffleOptions: true }), 'sample');

  // Stored compactly: ids and letters, not question text.
  assert.ok(!JSON.stringify(rec).includes('Which layer?'));
  assert.deepEqual(plain(app.attemptSummary(rec)), { total: 2, correct: 1, skipped: 1, score: 50 });

  const t = app.restoreAttempt(JSON.parse(JSON.stringify(rec)));
  assert.equal(t.fromHistory, true);
  assert.deepEqual(plain(t.answers), ['D', null]);
  assert.deepEqual(plain(t.questions[0].options), plain(shuffled.options));
  assert.equal(t.questions[0].answer, 'D');
  assert.equal(t.questions[0].options.D, 'Two');
  assert.equal(t.questions[1], other);
  assert.equal(t.endedAt - t.startedAt, 60000);
});

test('restoreAttempt keeps the score for questions that left or changed in the bank', () => {
  const base = app.normalize(raw(), 'f', 0);
  const gone = app.normalize(raw({ id: 'X-D2-009' }), 'f', 1);
  app.state.questions = [base, gone];
  const rec = app.attemptRecord(finished([base, gone], ['B', 'A']), 'sample');

  app.state.questions = [app.normalize(raw({ correct_option: 'C' }), 'f', 0)];
  const t = app.restoreAttempt(rec);
  assert.ok(t.questions.every((q) => q.unavailable));
  assert.deepEqual(plain(t.questions.map((q) => q.answer)), ['B', 'B']);
  assert.equal(t.questions[1].domainKey, 'D2');
  assert.deepEqual(plain(t.answers), ['B', 'A']);
});

test('restoreAttempt treats a stored order that no longer fits as unavailable', () => {
  const base = app.normalize(raw(), 'f', 0);
  app.state.questions = [base];
  const rec = app.attemptRecord(finished([app.shuffleOptions(base, ['A', 'B', 'C', 'D', 'E'])], ['B']), 'sample');
  assert.equal(app.restoreAttempt(rec).questions[0].unavailable, true);
});

test('recordAttempt keeps only the most recent attempts', () => {
  const base = app.normalize(raw(), 'f', 0);
  app.state.exam = { id: 'sample', domains: [] };
  app.state.attempts = [];
  for (let i = 0; i < app.MAX_ATTEMPTS + 5; i++) app.recordAttempt(finished([base], ['B'], { endedAt: i }));
  assert.equal(app.state.attempts.length, app.MAX_ATTEMPTS);
  assert.equal(app.state.attempts[0].endedAt, 5);
  assert.equal(app.state.attempts.at(-1).examId, 'sample');
});

test('attemptRecord stores each question\'s subtopic', () => {
  const base = app.normalize(raw(), 'f', 0);
  const rec = app.attemptRecord(finished([base], ['B']), 'sample');
  assert.equal(rec.questions[0].subtopic, 'OSI');
});

/* ---------- Performance ---------- */

const DOMAINS = [
  { key: 'D1', name: 'Networking', weight: 60 },
  { key: 'D2', name: 'Security', weight: 40 },
  { key: 'D3', name: 'Databases', weight: 0 },
];
const bankQ = (id, domainKey, subtopic) => ({ id, domainKey, subtopic });
const BANK = [
  bankQ('D1-1', 'D1', 'OSI'), bankQ('D1-2', 'D1', 'OSI'), bankQ('D1-3', 'D1', 'Routing'),
  bankQ('D2-1', 'D2', 'Crypto'), bankQ('D2-2', 'D2', 'Auth'),
];
// rows: [id, domain, right?, subtopic?]
const attempt = (rows, endedAt = 1) => ({
  examId: 'x', kind: 'new', endedAt,
  questions: rows.map(([id, domain, right, subtopic]) => ({ id, domain, chosen: right ? 'A' : 'B', answer: 'A', ...(subtopic ? { subtopic } : {}) })),
});

test('performanceStats totals each domain and subtopic, falling back to the bank for old records', () => {
  const stats = app.performanceStats([
    attempt([['D1-1', 'D1', true, 'OSI'], ['D1-3', 'D1', false], ['D2-1', 'D2', false]]),
    attempt([['D1-2', 'D1', true, 'osi '], ['D2-2', 'D2', true, 'Auth']], 2),
  ], BANK, DOMAINS);
  const d1 = stats.domains.find((d) => d.key === 'D1');
  assert.deepEqual([d1.correct, d1.total, d1.accuracy, d1.bank], [2, 3, 67, 3]);
  const osi = d1.subtopics.find((s) => s.name === 'OSI');
  assert.deepEqual([osi.correct, osi.total, osi.bank], [2, 2, 2]);
  assert.equal(d1.subtopics.find((s) => s.name === 'Routing').total, 1);
  assert.equal(stats.tests.length, 2);
  assert.deepEqual(plain(stats.tests[0].byDomain), { D1: { correct: 1, total: 2 }, D2: { correct: 0, total: 1 } });
  assert.equal(stats.tests[1].score, 100);
  assert.deepEqual([stats.overall.correct, stats.overall.total], [3, 5]);
  assert.equal(stats.domains.find((d) => d.key === 'D3').status, 'unpractised');
});

test('performanceStats weights recent tests more and pulls thin estimates toward the average', () => {
  const old = Array.from({ length: 10 }, (_, i) => attempt([['D1-1', 'D1', false], ['D2-1', 'D2', true]], i));
  const recent = Array.from({ length: 3 }, (_, i) => attempt([['D1-1', 'D1', true], ['D2-1', 'D2', true]], 20 + i));
  const d1 = app.performanceStats([...old, ...recent], BANK, DOMAINS).domains[0];
  assert.equal(d1.accuracy, 23);        // 3 of 13, unweighted
  assert.ok(d1.mastery > 0.4);          // recent right answers count for more
  assert.equal(d1.trend, 100);          // last 3 tests all right, earlier all wrong

  const single = app.performanceStats([attempt([['D1-1', 'D1', false], ['D2-1', 'D2', true], ['D2-2', 'D2', true]])], BANK, DOMAINS);
  const one = single.domains[0];
  assert.equal(one.accuracy, 0);
  assert.ok(one.mastery > 0.4 && one.mastery < 0.67);  // one miss isn't read as 0%
  assert.equal(one.trend, null);
});

test('recommendations rank weak domains by what they cost on the exam', () => {
  const rows = [
    ['D1-1', 'D1', false, 'OSI'], ['D1-2', 'D1', false, 'OSI'], ['D1-3', 'D1', true, 'Routing'],
    ['D2-1', 'D2', false, 'Crypto'], ['D2-2', 'D2', false, 'Auth'],
  ];
  const stats = app.performanceStats([attempt(rows, 1), attempt(rows, 2), attempt(rows, 3)], BANK, DOMAINS);
  const { focus, weights } = app.recommendations(stats);
  assert.deepEqual(plain(focus.map((d) => d.key)), ['D1', 'D2']);  // D2 is weaker, but D1 is worth more of the exam
  assert.equal(focus[0].subtopics[0].name, 'OSI');
  assert.ok(focus[0].subtopics.every((s) => s.name !== 'Routing'));
  assert.equal(weights.D1 + weights.D2, 100);
  assert.ok(weights.D1 > weights.D2);
  assert.equal(weights.D3, undefined);  // no questions and no answers
});

test('recommendations still name a domain when every domain passes', () => {
  const rows = [['D1-1', 'D1', true], ['D2-1', 'D2', true], ['D2-2', 'D2', true]];
  const stats = app.performanceStats(Array.from({ length: 6 }, (_, i) => attempt(rows, i)), BANK, DOMAINS);
  const { focus } = app.recommendations(stats);
  assert.equal(focus.length, 1);
  assert.equal(focus[0].polish, true);
  assert.equal(focus[0].key, 'D1');
});

test('performanceStats ignores answers from domains no longer in the exam', () => {
  const stats = app.performanceStats([attempt([['D9-1', 'D9', false], ['D1-1', 'D1', true]])], BANK, DOMAINS);
  assert.equal(stats.overall.total, 1);
});

/* ---------- Priority and picking ---------- */

test('prefer-unseen ranks fewer views, then older views, first', () => {
  app.state.history = { a: { seen: 2, last: 1 }, b: { seen: 1, last: 2000 }, c: { seen: 1, last: 1000 } };
  const order = app.orderByPriority([q('a'), q('b'), q('c'), q('d')], 'unseen').map((x) => x.id);
  assert.deepEqual(order, ['d', 'c', 'b', 'a']);
});

test('focus-on-missed ranks last-wrong by error rate, then unseen, then the rest', () => {
  app.state.history = {
    right: { seen: 1, wrong: 0 },
    halfWrong: { seen: 2, wrong: 1, lastWrong: true },
    allWrong: { seen: 2, wrong: 2, lastWrong: true },
  };
  const order = app.orderByPriority([q('right'), q('halfWrong'), q('unseen'), q('allWrong')], 'missed').map((x) => x.id);
  assert.deepEqual(order, ['allWrong', 'halfWrong', 'unseen', 'right']);
});

test('pickFromDomain uses every subtopic before repeating one', () => {
  const pool = [];
  for (const sub of ['A', 'B', 'C']) for (let i = 0; i < 4; i++) pool.push(q(`${sub}${i}`, sub));
  for (let trial = 0; trial < 20; trial++) {
    const picked = app.pickFromDomain(pool, 9, 'random');
    assert.equal(picked.length, 9);
    for (let round = 0; round < 3; round++) {
      const subs = picked.slice(round * 3, round * 3 + 3).map((x) => x.subtopic).sort();
      assert.deepEqual(plain(subs), ['A', 'B', 'C']);
    }
  }
});

test('pickFromDomain groups subtopics case-insensitively and never duplicates', () => {
  const pool = [q('1', 'Loops'), q('2', 'loops '), q('3', 'Arrays')];
  const picked = app.pickFromDomain(pool, 10, 'random');
  assert.equal(picked.length, 3);
  assert.equal(new Set(picked.map((x) => x.id)).size, 3);
  assert.equal(picked[0].subtopic === 'Arrays' || picked[1].subtopic === 'Arrays', true);
});

test('pickFromDomain handles empty input', () => {
  assert.equal(app.pickFromDomain([], 5, 'unseen').length, 0);
  assert.equal(app.pickFromDomain([q('a')], 0, 'unseen').length, 0);
});

/* ---------- Weights from settings ---------- */

test('currentWeights follows the distribution setting', () => {
  const exam = { id: 'e', domains: [{ key: 'D1', weight: 30 }, { key: 'D2', weight: 70 }] };
  const saved = { exam: app.state.exam, settings: app.state.settings };
  try {
    app.state.exam = exam;
    app.state.settings = { ...saved.settings, distribution: 'exam' };
    assert.deepEqual(plain(app.currentWeights()), { D1: 30, D2: 70 });
    app.state.settings = { ...saved.settings, distribution: 'custom', customWeights: { e: { D1: 5, D2: -3 } } };
    assert.deepEqual(plain(app.currentWeights()), { D1: 5, D2: 0 });
    app.state.settings = { ...saved.settings, distribution: 'single', singleDomain: 'D2' };
    assert.deepEqual(plain(app.currentWeights()), { D1: 0, D2: 1 });
    app.state.settings = { ...saved.settings, distribution: 'single', singleDomain: 'nope' };
    assert.deepEqual(plain(app.currentWeights()), { D1: 1, D2: 0 });
  } finally {
    app.state.exam = saved.exam;
    app.state.settings = saved.settings;
  }
});

/* ---------- Small helpers ---------- */

test('formatDuration', () => {
  assert.equal(app.formatDuration(0), '0:00');
  assert.equal(app.formatDuration(65_000), '1:05');
  assert.equal(app.formatDuration(3_725_000), '1:02:05');
  assert.equal(app.formatDuration(-5), '0:00');
});

test('clamp and pct', () => {
  assert.equal(app.clamp(500, 1, 200), 200);
  assert.equal(app.clamp(-1, 1, 200), 1);
  assert.equal(app.pct(1, 3), 33);
  assert.equal(app.pct(1, 0), 0);
});
