'use strict';

/* =====================================================================
 * Practice Test App
 * Deterministic question selection: no network calls beyond local files.
 * ===================================================================== */

const MAX_QUESTIONS = 200;
const MAX_ATTEMPTS = 100;  // finished tests kept in test history, across all exams

const DEFAULT_SETTINGS = {
  examId: null,
  count: 50,
  distribution: 'exam',   // exam | custom | single
  customWeights: {},      // { [examId]: { [domainKey]: weight } }
  singleDomain: null,
  priority: 'unseen',     // unseen | missed | random
  allowSkip: true,
  feedback: 'immediate',  // immediate | end
  order: 'shuffle',       // shuffle | grouped
  shuffleOptions: false,
};

const state = {
  exams: [],
  exam: null,
  questions: [],
  batches: [],
  warnings: [],
  settings: { ...DEFAULT_SETTINGS, ...store.get(KEYS.settings, {}) },
  history: store.get(KEYS.history, {}) || {},
  attempts: [].concat(store.get(KEYS.attempts, []) || []).filter((a) => a && Array.isArray(a.questions)),
  test: null,
  timer: null,
  reviewFilter: 'all',
};

const saveSettings = () => store.set(KEYS.settings, state.settings);
const saveHistory = () => store.set(KEYS.history, state.history);
const saveAttempts = () => store.set(KEYS.attempts, state.attempts);

/* ---------- Helpers ---------- */

const app = () => $('#app');

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Returns a copy of the question with its option texts moved to random letters.
// The letters themselves stay in place; the answer and distractors follow their text.
// order[i] is the original letter shown at position i; pass one to replay a past shuffle.
function shuffleOptions(q, order) {
  const base = q.source || q;
  order ||= shuffle(base.letters);
  const toNew = Object.fromEntries(order.map((orig, i) => [orig, base.letters[i]]));
  const remap = (obj) => Object.fromEntries(Object.entries(obj).map(([k, v]) => [toNew[k] ?? k, v]));
  return {
    ...base,
    options: remap(base.options),
    answer: toNew[base.answer],
    distractors: remap(base.distractors),
    optionOrder: order,
    source: base,
  };
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) {
    const k = fn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function formatDuration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

const formatDate = (ts) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const domainOf = (key) => state.exam?.domains.find((d) => d.key === key);
const domainName = (key) => domainOf(key)?.name || key || 'Unknown domain';

/* =====================================================================
 * Loading
 * ===================================================================== */

async function loadExams() {
  state.exams = await fetchExams();
  if (!state.exams.length) throw new Error('No exams are registered in exams.json or exams.local.json.');
}

async function loadExam(exam) {
  state.exam = exam;
  state.questions = [];
  state.batches = [];
  state.warnings = [];
  document.title = exam.title || `${exam.name} Practice Test`;
  $('#app-title').textContent = exam.title || `${exam.name} Practice Test`;

  let manifest;
  try {
    manifest = await fetchJson(exam.manifest);
  } catch (e) {
    state.warnings.push(`Could not load manifest "${exam.manifest}": ${e.message}`);
    return;
  }

  const base = exam.manifest.includes('/') ? exam.manifest.slice(0, exam.manifest.lastIndexOf('/') + 1) : '';
  const files = (manifest.batches || []).map((b) => b && b.file_name).filter(Boolean);
  if (!files.length) state.warnings.push('The manifest does not list any batches.');

  const results = await Promise.allSettled(files.map((f) => fetchJson(base + f)));
  const byId = new Map();
  let loaded = 0;

  results.forEach((r, i) => {
    const file = files[i];
    if (r.status === 'rejected') {
      state.warnings.push(`${file}: ${r.reason.message}`);
      state.batches.push({ file, count: 0, error: true });
      return;
    }
    const raw = Array.isArray(r.value) ? r.value : (r.value && r.value.questions) || [];
    let ok = 0, bad = 0;
    raw.forEach((item, idx) => {
      const q = normalize(item, file, idx);
      if (q) { byId.set(q.id, q); ok++; } else bad++;
    });
    if (bad) state.warnings.push(`${file}: skipped ${bad} invalid question${bad > 1 ? 's' : ''}.`);
    loaded += ok;
    state.batches.push({ file, count: ok });
  });

  const all = [...byId.values()];
  const dupes = loaded - all.length;
  if (dupes) state.warnings.push(`${dupes} duplicate question ID${dupes > 1 ? 's' : ''} across batches (later batch kept).`);

  const known = new Set(exam.domains.map((d) => d.key));
  const unknown = all.filter((q) => !known.has(q.domainKey));
  if (unknown.length) {
    state.warnings.push(`${unknown.length} question${unknown.length > 1 ? 's have' : ' has'} a domain that isn't in exams.json and will be ignored (e.g. ${unknown[0].id}).`);
  }
  state.questions = all.filter((q) => known.has(q.domainKey));
}

/* =====================================================================
 * Selection engine (deterministic rules + random tie-breaking)
 * ===================================================================== */

// Split n across weighted keys so the parts sum to exactly n. Ties go to the
// heavier weight, then to the earlier key, so the split is reproducible.
function largestRemainder(n, entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  const out = Object.fromEntries(entries.map(([k]) => [k, 0]));
  if (!total || n <= 0) return out;
  const parts = entries.map(([k, w], i) => {
    const exact = (n * w) / total;
    const base = Math.floor(exact + 1e-9);
    return { k, w, i, base, rem: Math.round((exact - base) * 1e9) };
  });
  let left = n - parts.reduce((s, p) => s + p.base, 0);
  parts.slice().sort((a, b) => b.rem - a.rem || b.w - a.w || a.i - b.i)
    .slice(0, left).forEach((p) => { p.base++; });
  parts.forEach((p) => { out[p.k] = p.base; });
  return out;
}

// Allocate n questions across domains by weight, capping each domain at what
// it has and redistributing any shortfall to the others by weight.
function allocate(n, weights, available) {
  const keys = Object.keys(weights).filter((k) => weights[k] > 0);
  const capacity = keys.reduce((s, k) => s + (available[k] || 0), 0);
  const target = Math.min(n, capacity);
  const ideal = largestRemainder(target, keys.map((k) => [k, weights[k]]));
  const alloc = Object.fromEntries(keys.map((k) => [k, 0]));

  let active = keys.filter((k) => (available[k] || 0) > 0);
  let remaining = target;
  while (remaining > 0 && active.length) {
    const share = largestRemainder(remaining, active.map((k) => [k, weights[k]]));
    const capped = active.filter((k) => alloc[k] + share[k] > available[k]);
    if (!capped.length) {
      active.forEach((k) => { alloc[k] += share[k]; });
      remaining = 0;
      break;
    }
    capped.forEach((k) => { remaining -= available[k] - alloc[k]; alloc[k] = available[k]; });
    active = active.filter((k) => !capped.includes(k));
  }

  const shortfalls = keys
    .filter((k) => alloc[k] < ideal[k])
    .map((k) => ({ key: k, short: ideal[k] - alloc[k] }));
  return { alloc, ideal, target, capacity, shortfalls };
}

// Lower score = picked earlier.
function priorityScore(q, mode) {
  if (mode === 'random') return 0;
  const h = state.history[q.id];
  const seen = h?.seen || 0;
  if (mode === 'missed') {
    if (h?.lastWrong) return -1 - (h.wrong || 0) / Math.max(1, seen);
    return seen;
  }
  // unseen: fewest views first, then the ones seen longest ago
  return seen + (h?.last || 0) / 1e13;
}

function orderByPriority(list, mode) {
  return shuffle(list)
    .map((q) => [priorityScore(q, mode), q])
    .sort((a, b) => a[0] - b[0])
    .map((x) => x[1]);
}

// Take one item from each group per round so no group repeats until all have
// been used. Within a round, groups whose next item has the best priority go first.
function interleave(groups, score) {
  const queues = shuffle(groups.filter((g) => g.length)).map((g) => g.slice());
  const out = [];
  while (queues.length) {
    queues.sort((a, b) => score(a[0]) - score(b[0]));
    for (const q of queues) out.push(q.shift());
    for (let i = queues.length - 1; i >= 0; i--) if (!queues[i].length) queues.splice(i, 1);
  }
  return out;
}

function pickFromDomain(pool, count, mode) {
  if (count <= 0 || !pool.length) return [];
  const score = (q) => priorityScore(q, mode);
  const streams = [...groupBy(pool, (q) => q.objective).values()].map((objQs) => {
    const subtopicGroups = [...groupBy(objQs, (q) => q.subtopic.trim().toLowerCase()).values()];
    return interleave(subtopicGroups.map((g) => orderByPriority(g, mode)), score);
  });
  return interleave(streams, score).slice(0, count);
}

function currentWeights() {
  const s = state.settings, domains = state.exam.domains;
  if (s.distribution === 'custom') {
    const custom = s.customWeights[state.exam.id] || {};
    return Object.fromEntries(domains.map((d) => [d.key, Math.max(0, Number(custom[d.key] ?? d.weight) || 0)]));
  }
  if (s.distribution === 'single') {
    const key = domains.some((d) => d.key === s.singleDomain) ? s.singleDomain : domains[0].key;
    return Object.fromEntries(domains.map((d) => [d.key, d.key === key ? 1 : 0]));
  }
  return Object.fromEntries(domains.map((d) => [d.key, Number(d.weight) || 0]));
}

function availableByDomain() {
  const counts = Object.fromEntries(state.exam.domains.map((d) => [d.key, 0]));
  for (const q of state.questions) counts[q.domainKey]++;
  return counts;
}

function planTest() {
  return allocate(clamp(state.settings.count, 1, MAX_QUESTIONS), currentWeights(), availableByDomain());
}

function generateTest() {
  const plan = planTest();
  const byDomain = groupBy(state.questions, (q) => q.domainKey);
  let picked = [];
  for (const d of state.exam.domains) {
    picked.push(...pickFromDomain(byDomain.get(d.key) || [], plan.alloc[d.key] || 0, state.settings.priority));
  }
  if (state.settings.order === 'shuffle') picked = shuffle(picked);
  startTest(picked);
}

/* =====================================================================
 * Setup screen
 * ===================================================================== */

function renderFatal(title, html) {
  app().innerHTML = `<div class="card"><h2>${esc(title)}</h2>${html}</div>`;
}

function renderSetup() {
  stopTimer();
  state.test = null;
  const s = state.settings, exam = state.exam;
  const total = state.questions.length;
  const maxCount = Math.min(MAX_QUESTIONS, total);
  s.count = clamp(s.count, 1, Math.max(1, maxCount));
  const avail = availableByDomain();
  const weightSum = exam.domains.reduce((a, d) => a + (Number(d.weight) || 0), 0);
  const seenCount = state.questions.filter((q) => state.history[q.id]?.seen).length;
  const testsTaken = examAttempts().length;
  const custom = s.customWeights[exam.id] || {};

  const examPicker = state.exams.length > 1 ? `
    <div class="row exam-picker">
      <label class="field" for="exam-select">Exam</label>
      <select id="exam-select">
        ${state.exams.map((e) => `<option value="${esc(e.id)}" ${e.id === exam.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
      </select>
    </div>` : '';

  const domainRows = exam.domains.map((d) => {
    const share = pct(avail[d.key], total);
    const target = weightSum ? (Number(d.weight) / weightSum) * 100 : 0;
    return `<tr>
      <td><span class="dkey">${esc(d.key)}</span>${esc(d.name)}</td>
      <td class="num">${avail[d.key]}</td>
      <td class="bar-cell" title="Bank share ${share}% vs exam weight ${Math.round(target)}%">
        <div class="bar"><span style="width:${share}%"></span><i style="left:${target}%"></i></div>
      </td>
      <td class="num">${share}% <span class="muted">/ ${Math.round(target)}%</span></td>
    </tr>`;
  }).join('');

  const warnings = state.warnings.length
    ? `<div class="notice notice-warn"><b>Heads up</b><ul>${state.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>Question bank</h2>
        <div class="row">
          <button class="btn btn-sm" id="show-history" type="button">Test history</button>
          <a class="btn btn-sm" href="manage.html">Manage tests</a>
          <button class="btn btn-sm" id="reload-bank" type="button">↻ Reload bank</button>
        </div>
      </div>
      ${examPicker}
      <div class="stat-line">
        <div class="stat"><b>${total}</b><span>questions</span></div>
        <div class="stat"><b>${state.batches.length}</b><span>batch${state.batches.length === 1 ? '' : 'es'}</span></div>
        <div class="stat"><b>${seenCount}</b><span>seen before</span></div>
        <div class="stat"><b>${testsTaken}</b><span>test${testsTaken === 1 ? '' : 's'} taken</span></div>
      </div>
      <table class="domain-table">
        <thead><tr><th>Domain</th><th class="num">Questions</th><th>Bank share vs exam weight</th><th class="num">Share / weight</th></tr></thead>
        <tbody>${domainRows}</tbody>
      </table>
      ${warnings}
    </section>

    <section class="card">
      <h2>Test composition</h2>
      <div class="grid-2">
        <div>
          <label class="field" for="count-number">Number of questions</label>
          <div class="row">
            <input type="range" id="count-range" min="1" max="${Math.max(1, maxCount)}" value="${s.count}" ${total ? '' : 'disabled'}>
            <input type="number" id="count-number" min="1" max="${Math.max(1, maxCount)}" value="${s.count}" ${total ? '' : 'disabled'}>
          </div>
          <div class="field-help">Up to ${MAX_QUESTIONS}; ${total} available in the bank.</div>
        </div>
        <div>
          <span class="field">Domain distribution</span>
          <div class="segmented" role="radiogroup" aria-label="Domain distribution">
            ${radio('distribution', 'exam', 'Exam weights', s.distribution)}
            ${radio('distribution', 'custom', 'Custom', s.distribution)}
            ${radio('distribution', 'single', 'Single domain', s.distribution)}
          </div>
          <div id="single-wrap" ${s.distribution === 'single' ? '' : 'hidden'} style="margin-top:.6rem">
            <select id="single-domain" aria-label="Domain">
              ${exam.domains.map((d) => `<option value="${esc(d.key)}" ${d.key === s.singleDomain ? 'selected' : ''}>${esc(d.key)} · ${esc(d.name)}</option>`).join('')}
            </select>
          </div>
        </div>
      </div>
      <div id="custom-wrap" class="custom-weights" ${s.distribution === 'custom' ? '' : 'hidden'}>
        ${exam.domains.map((d) => `<label><span><span class="dkey">${esc(d.key)}</span>${esc(shortName(d.name))}</span>
          <input type="number" min="0" max="100" step="1" data-weight="${esc(d.key)}" value="${esc(custom[d.key] ?? d.weight)}"></label>`).join('')}
      </div>
      <div id="plan-preview"></div>
    </section>

    <section class="card">
      <h2>Test options</h2>
      <div class="grid-2">
        <div>
          <label class="switch"><input type="checkbox" id="allow-skip" ${s.allowSkip ? 'checked' : ''}><span class="track"></span>Allow skipping questions</label>
          <div class="field-help">When off, each question must be answered before moving on.</div>
        </div>
        <div>
          <span class="field">Show answers</span>
          <div class="segmented" role="radiogroup" aria-label="Show answers">
            ${radio('feedback', 'immediate', 'Immediately', s.feedback)}
            ${radio('feedback', 'end', 'At the end', s.feedback)}
          </div>
        </div>
        <div>
          <label class="field" for="priority">Question selection</label>
          <div class="row">
            <select id="priority">
              <option value="unseen" ${s.priority === 'unseen' ? 'selected' : ''}>Prefer unseen questions</option>
              <option value="missed" ${s.priority === 'missed' ? 'selected' : ''}>Focus on questions I missed</option>
              <option value="random" ${s.priority === 'random' ? 'selected' : ''}>Random</option>
            </select>
            <button class="btn btn-sm" id="reset-history" type="button">Reset history</button>
          </div>
        </div>
        <div>
          <span class="field">Question order</span>
          <div class="segmented" role="radiogroup" aria-label="Question order">
            ${radio('order', 'shuffle', 'Shuffled', s.order)}
            ${radio('order', 'grouped', 'Grouped by domain', s.order)}
          </div>
        </div>
        <div>
          <label class="switch"><input type="checkbox" id="shuffle-options" ${s.shuffleOptions ? 'checked' : ''}><span class="track"></span>Shuffle answer choices</label>
          <div class="field-help">Rearranges each question's options so you can't memorise answers by letter.</div>
        </div>
      </div>
    </section>

    <div class="start-bar">
      <button class="btn btn-primary btn-lg" id="start-test" type="button" ${total ? '' : 'disabled'}>Start test →</button>
    </div>`;

  updatePlanPreview();
  bindSetup();
}

function radio(name, value, label, current) {
  return `<label><input type="radio" name="${name}" value="${value}" ${current === value ? 'checked' : ''}>${esc(label)}</label>`;
}

const shortName = (name) => name.replace(/\s*\(.*?\)\s*/g, ' ').trim();

function updatePlanPreview() {
  const el = $('#plan-preview');
  if (!el) return;
  if (!state.questions.length) {
    el.innerHTML = '<div class="notice notice-bad">No questions loaded. Check the manifest and batch files, then click Reload bank.</div>';
    return;
  }
  const plan = planTest();
  const shortKeys = new Set(plan.shortfalls.map((x) => x.key));
  const chips = state.exam.domains
    .filter((d) => (plan.alloc[d.key] || 0) > 0 || (plan.ideal[d.key] || 0) > 0)
    .map((d) => `<span class="chip ${shortKeys.has(d.key) ? 'short' : ''}" title="${esc(d.name)}">${esc(d.key)} <b>${plan.alloc[d.key] || 0}</b></span>`)
    .join('');

  const notes = [];
  if (plan.target < state.settings.count) {
    notes.push(`Only ${plan.capacity} question${plan.capacity === 1 ? '' : 's'} available for this distribution, so the test will have ${plan.target}.`);
  }
  if (plan.shortfalls.length && plan.target > 0) {
    const parts = plan.shortfalls.map((x) => `${x.key} short by ${x.short}`).join(', ');
    notes.push(`${parts}; ${plan.target === plan.capacity ? 'every available question is used' : 'filled from the other domains by weight'}.`);
  }
  el.innerHTML = `
    <div class="split"><span class="muted small" style="align-self:center">Split for this test:</span>${chips || '<span class="muted small">no domains selected</span>'}</div>
    ${notes.length ? `<div class="notice notice-warn">${notes.map(esc).join('<br>')}</div>` : ''}`;
  const start = $('#start-test');
  if (start) start.disabled = plan.target === 0;
}

function bindSetup() {
  const s = state.settings;
  const commit = () => { saveSettings(); updatePlanPreview(); };

  const range = $('#count-range'), num = $('#count-number');
  const setCount = (v, fromNumber) => {
    const max = Number(range.max);
    const n = clamp(Math.round(Number(v) || 1), 1, max);
    s.count = n;
    range.value = n;
    if (!fromNumber) num.value = n;
    commit();
  };
  range.addEventListener('input', () => setCount(range.value));
  num.addEventListener('input', () => { if (num.value !== '') setCount(num.value, true); });
  num.addEventListener('change', () => setCount(num.value));

  app().querySelectorAll('input[type="radio"]').forEach((r) => r.addEventListener('change', () => {
    s[r.name] = r.value;
    if (r.name === 'distribution') {
      $('#custom-wrap').hidden = r.value !== 'custom';
      $('#single-wrap').hidden = r.value !== 'single';
      if (r.value === 'single' && !s.singleDomain) s.singleDomain = $('#single-domain').value;
    }
    commit();
  }));

  $('#single-domain').addEventListener('change', (e) => { s.singleDomain = e.target.value; commit(); });

  app().querySelectorAll('[data-weight]').forEach((input) => input.addEventListener('input', () => {
    const w = (s.customWeights[state.exam.id] ||= {});
    w[input.dataset.weight] = Math.max(0, Number(input.value) || 0);
    commit();
  }));

  $('#allow-skip').addEventListener('change', (e) => { s.allowSkip = e.target.checked; commit(); });
  $('#shuffle-options').addEventListener('change', (e) => { s.shuffleOptions = e.target.checked; commit(); });
  $('#priority').addEventListener('change', (e) => { s.priority = e.target.value; commit(); });

  $('#reset-history').addEventListener('click', () => {
    if (!confirm('Clear your answer history? "Prefer unseen" and "Focus on missed" will start fresh. Your test history is kept.')) return;
    state.history = {};
    saveHistory();
    renderSetup();
  });

  $('#show-history').addEventListener('click', renderHistory);

  $('#reload-bank').addEventListener('click', async () => {
    app().innerHTML = '<div class="loading">Reloading question bank…</div>';
    await loadExam(state.exam);
    renderSetup();
  });

  const examSelect = $('#exam-select');
  if (examSelect) examSelect.addEventListener('change', async () => {
    const exam = state.exams.find((e) => e.id === examSelect.value);
    s.examId = exam.id;
    saveSettings();
    app().innerHTML = '<div class="loading">Loading question bank…</div>';
    await loadExam(exam);
    renderSetup();
  });

  $('#start-test').addEventListener('click', generateTest);
}

/* =====================================================================
 * Test screen
 * ===================================================================== */

// kind: new | retake | missed (how the test was started; shown in test history)
function startTest(questions, kind = 'new') {
  if (!questions.length) return;
  const n = questions.length;
  const shuffled = state.settings.shuffleOptions;
  state.test = {
    kind,
    questions: questions.map((q) => (shuffled ? shuffleOptions(q) : q.source || q)),
    shuffleOptions: shuffled,
    answers: Array(n).fill(null),
    locked: Array(n).fill(false),
    visited: Array(n).fill(false),
    current: 0,
    furthest: 0,
    allowSkip: state.settings.allowSkip,
    feedback: state.settings.feedback,
    startedAt: Date.now(),
    endedAt: null,
  };
  state.test.visited[0] = true;
  state.reviewFilter = 'all';
  startTimer();
  renderTest();
  window.scrollTo(0, 0);
}

function startTimer() {
  stopTimer();
  state.timer = setInterval(() => {
    const el = $('#elapsed');
    if (el && state.test) el.textContent = formatDuration(Date.now() - state.test.startedAt);
  }, 1000);
}

function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

const isRevealed = (t, i) => t.feedback === 'immediate' && t.locked[i];

// Without skipping, only questions already reached, or the one right after an answered one, are reachable.
const canVisit = (t, i) => t.allowSkip || i <= t.furthest || (i === t.furthest + 1 && t.answers[t.furthest] != null);

function renderTest() {
  const t = state.test, i = t.current, q = t.questions[i], n = t.questions.length;
  const chosen = t.answers[i];
  const reveal = isRevealed(t, i);
  const answered = t.answers.filter((a) => a != null).length;
  const isLast = i === n - 1;

  let scoreText = '';
  if (t.feedback === 'immediate') {
    const graded = t.locked.filter(Boolean).length;
    const right = t.questions.filter((qq, k) => t.locked[k] && t.answers[k] === qq.answer).length;
    scoreText = ` · Score ${right}/${graded}`;
  }

  const options = q.letters.map((L) => {
    const cls = ['option'];
    if (reveal) {
      if (L === q.answer) cls.push('correct');
      else if (L === chosen) cls.push('incorrect');
    } else if (L === chosen) cls.push('selected');
    return `<button type="button" class="${cls.join(' ')}" data-letter="${L}" ${t.locked[i] ? 'disabled' : ''} aria-pressed="${L === chosen}">
      <span class="letter">${L}</span><span>${esc(q.options[L])}</span></button>`;
  }).join('');

  let feedback = '';
  if (reveal) {
    const good = chosen === q.answer;
    feedback = `<div class="feedback ${good ? 'good' : 'bad'}" role="status">
      <div class="verdict">${good ? '✓ Correct' : `✗ Incorrect. The answer is ${q.answer}.`}</div>
      ${q.explanation ? `<p>${esc(q.explanation)}</p>` : ''}
      ${!good && q.distractors[chosen] ? `<p><b>Why ${chosen} is wrong:</b> ${esc(q.distractors[chosen])}</p>` : ''}
    </div>`;
  }

  // In skip mode, the forward button doubles as "Skip" until the question is answered.
  const canAdvance = t.allowSkip || chosen != null;
  const forwardLabel = chosen == null && t.allowSkip ? 'Skip →' : 'Next →';
  const forwardBtn = isLast
    ? `<button class="btn btn-primary" id="finish" type="button" ${t.allowSkip || chosen != null ? '' : 'disabled'}>Finish test</button>`
    : `<button class="btn btn-primary" id="next" type="button" ${canAdvance ? '' : 'disabled'}>${forwardLabel}</button>`;

  const navCells = t.questions.map((qq, k) => {
    const cls = ['nav-cell'];
    if (isRevealed(t, k)) cls.push(t.answers[k] === qq.answer ? 'correct' : 'incorrect');
    else if (t.answers[k] != null) cls.push('answered');
    else if (t.visited[k] && k !== i) cls.push('skipped');
    if (k === i) cls.push('current');
    return `<button type="button" class="${cls.join(' ')}" data-goto="${k}" ${canVisit(t, k) ? '' : 'disabled'} aria-label="Question ${k + 1}">${k + 1}</button>`;
  }).join('');

  const legend = t.feedback === 'immediate'
    ? '<span class="l-correct">Correct</span><span class="l-incorrect">Incorrect</span>'
    : '<span class="l-answered">Answered</span>';

  app().innerHTML = `
    <section class="card">
      <div class="test-head">
        <span class="counter">Question ${i + 1} of ${n}</span>
        <span class="meta">${answered} answered${scoreText} · <span id="elapsed">${formatDuration(Date.now() - t.startedAt)}</span></span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="quit" type="button">Quit</button>
      </div>
      <div class="progress" aria-hidden="true"><span style="width:${pct(answered, n)}%"></span></div>
      <div class="tags">
        <span class="tag">${esc(q.domainKey)} · ${esc(shortName(domainName(q.domainKey)))}</span>
        <span class="tag plain">${esc(q.subtopic)}</span>
      </div>
      <div class="stem">${esc(q.stem)}</div>
      <div class="options">${options}</div>
      ${feedback}
      <div class="test-controls">
        <button class="btn" id="prev" type="button" ${i === 0 ? 'disabled' : ''}>← Previous</button>
        <span class="spacer"></span>
        ${forwardBtn}
      </div>
      <div class="kbd-hint"><kbd>1</kbd>–<kbd>${q.letters.length}</kbd> or <kbd>A</kbd>–<kbd>${q.letters[q.letters.length - 1]}</kbd> to answer · <kbd>←</kbd> <kbd>→</kbd> to move</div>
    </section>

    <section class="card">
      <div class="card-head">
        <h3 style="margin:0">Questions</h3>
        ${t.allowSkip && !isLast ? '<button class="btn btn-sm" id="finish-early" type="button">Finish test</button>' : ''}
      </div>
      <div class="navigator">${navCells}</div>
      <div class="legend">${legend}${t.allowSkip ? '<span class="l-skipped">Skipped</span>' : ''}</div>
    </section>`;

  bindTest();
}

function bindTest() {
  app().querySelectorAll('.option').forEach((b) => b.addEventListener('click', () => choose(b.dataset.letter)));
  app().querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => goTo(Number(b.dataset.goto))));
  $('#prev').addEventListener('click', () => goTo(state.test.current - 1));
  $('#next')?.addEventListener('click', next);
  $('#finish')?.addEventListener('click', finishTest);
  $('#finish-early')?.addEventListener('click', finishTest);
  $('#quit').addEventListener('click', () => {
    if (confirm('Quit this test? Your progress will be lost.')) renderSetup();
  });
}

function choose(letter) {
  const t = state.test, i = t.current;
  if (t.locked[i] || !t.questions[i].letters.includes(letter)) return;
  t.answers[i] = letter;
  if (t.feedback === 'immediate') t.locked[i] = true;
  renderTest();
}

function goTo(i) {
  const t = state.test;
  if (i < 0 || i >= t.questions.length) return;
  if (!canVisit(t, i)) return;
  t.current = i;
  t.visited[i] = true;
  t.furthest = Math.max(t.furthest, i);
  renderTest();
  window.scrollTo({ top: 0 });
}

function next() {
  const t = state.test;
  if (!t.allowSkip && t.answers[t.current] == null) return;
  goTo(t.current + 1);
}

function finishTest() {
  const t = state.test;
  const unanswered = t.answers.filter((a) => a == null).length;
  if (unanswered && !confirm(`You have ${unanswered} unanswered question${unanswered > 1 ? 's' : ''}. ${unanswered > 1 ? 'They' : 'It'} will be marked incorrect. Finish anyway?`)) return;
  if (!unanswered && t.feedback === 'end' && !confirm('Submit your answers and see your results?')) return;

  stopTimer();
  t.endedAt = Date.now();
  t.questions.forEach((q, i) => {
    const h = (state.history[q.id] ||= { seen: 0, wrong: 0, last: 0 });
    const wrong = t.answers[i] !== q.answer;
    h.seen++;
    if (wrong) h.wrong++;
    h.lastWrong = wrong;
    h.last = t.endedAt;
  });
  saveHistory();
  recordAttempt(t);
  renderResults();
  window.scrollTo(0, 0);
}

function handleKey(e) {
  const t = state.test;
  if (!t || t.endedAt || e.ctrlKey || e.metaKey || e.altKey) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const q = t.questions[t.current];
  const key = e.key.toUpperCase();
  if (/^[1-9]$/.test(key) && q.letters[Number(key) - 1]) { choose(q.letters[Number(key) - 1]); e.preventDefault(); }
  else if (key.length === 1 && q.letters.includes(key)) { choose(key); e.preventDefault(); }
  else if (e.key === 'ArrowRight') { if (t.current < t.questions.length - 1) next(); e.preventDefault(); }
  else if (e.key === 'ArrowLeft') { goTo(t.current - 1); e.preventDefault(); }
}

/* =====================================================================
 * Results screen
 * ===================================================================== */

function renderResults() {
  const t = state.test, n = t.questions.length;
  const results = t.questions.map((q, i) => ({
    q, i, chosen: t.answers[i],
    status: t.answers[i] == null ? 'skipped' : t.answers[i] === q.answer ? 'correct' : 'incorrect',
  }));
  const correct = results.filter((r) => r.status === 'correct').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const missed = results.filter((r) => r.status !== 'correct' && !r.q.unavailable);
  const retakeable = t.questions.filter((q) => !q.unavailable);
  const unavailable = n - retakeable.length;
  const score = pct(correct, n);
  const weightSum = state.exam.domains.reduce((a, d) => a + (Number(d.weight) || 0), 0);

  const byDomain = groupBy(results, (r) => r.q.domainKey);
  const domainRows = state.exam.domains.filter((d) => byDomain.has(d.key)).map((d) => {
    const rs = byDomain.get(d.key);
    const c = rs.filter((r) => r.status === 'correct').length;
    const p = pct(c, rs.length);
    return `<tr>
      <td><span class="dkey">${esc(d.key)}</span>${esc(d.name)}</td>
      <td class="num">${c}/${rs.length}</td>
      <td class="bar-cell"><div class="bar"><span style="width:${p}%;background:${p >= 70 ? 'var(--good)' : 'var(--bad)'}"></span></div></td>
      <td class="num">${p}%</td>
      <td class="num muted">${weightSum ? Math.round((d.weight / weightSum) * 100) : 0}%</td>
    </tr>`;
  }).join('');

  app().innerHTML = `
    <section class="card">
      <div class="score-hero">
        <div class="score-big ${score >= 70 ? 'pass' : 'fail'}">${score}%</div>
        <div>
          <div><b>${correct}</b> of <b>${n}</b> correct${skipped ? ` · ${skipped} unanswered` : ''}</div>
          <div class="muted">Time ${formatDuration(t.endedAt - t.startedAt)} · ${t.feedback === 'immediate' ? 'Immediate feedback' : 'Feedback at end'} · ${t.allowSkip ? 'Skipping allowed' : 'No skipping'}${t.shuffleOptions ? ' · Choices shuffled' : ''}</div>
          ${t.fromHistory ? `<div class="muted">Taken ${esc(formatDate(t.endedAt))}</div>` : ''}
        </div>
      </div>
      ${unavailable ? `<div class="notice notice-warn">${unavailable} question${unavailable > 1 ? 's have' : ' has'} been removed or changed in the bank since this test, so ${unavailable > 1 ? 'they' : 'it'} can't be shown or retaken.</div>` : ''}
      <div class="row" style="margin-top:1.1rem">
        <button class="btn btn-primary" id="new-test" type="button">New test</button>
        <button class="btn" id="retake" type="button" ${retakeable.length ? '' : 'disabled'}>Retake same questions</button>
        <button class="btn" id="retry-missed" type="button" ${missed.length ? '' : 'disabled'}>Practice the ${missed.length} missed</button>
        <button class="btn" id="to-history" type="button">${t.fromHistory ? '← Back to history' : 'Test history'}</button>
      </div>
    </section>

    <section class="card">
      <h2>By domain</h2>
      <table class="domain-table">
        <thead><tr><th>Domain</th><th class="num">Correct</th><th></th><th class="num">Score</th><th class="num">Exam weight</th></tr></thead>
        <tbody>${domainRows}</tbody>
      </table>
    </section>

    <section class="card">
      <div class="card-head">
        <h2>Review</h2>
        <div class="filters" role="group" aria-label="Filter review">
          ${filterBtn('all', `All (${n})`)}
          ${filterBtn('incorrect', `Incorrect (${results.filter((r) => r.status === 'incorrect').length})`)}
          ${filterBtn('skipped', `Unanswered (${skipped})`)}
        </div>
      </div>
      <div id="review-list"></div>
    </section>`;

  renderReviewList(results);

  app().querySelectorAll('[data-filter]').forEach((b) => b.addEventListener('click', () => {
    state.reviewFilter = b.dataset.filter;
    app().querySelectorAll('[data-filter]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    renderReviewList(results);
  }));
  $('#new-test').addEventListener('click', renderSetup);
  $('#retake').addEventListener('click', () => startTest(retakeable, 'retake'));
  $('#retry-missed').addEventListener('click', () => startTest(shuffle(missed.map((r) => r.q)), 'missed'));
  $('#to-history').addEventListener('click', renderHistory);
}

function filterBtn(value, label) {
  return `<button type="button" class="btn btn-sm" data-filter="${value}" aria-pressed="${state.reviewFilter === value}">${esc(label)}</button>`;
}

function renderReviewList(results) {
  const f = state.reviewFilter;
  const shown = f === 'all' ? results : results.filter((r) => r.status === f);
  const el = $('#review-list');
  if (!shown.length) { el.innerHTML = '<div class="empty">Nothing to show here.</div>'; return; }

  el.innerHTML = shown.map(({ q, i, chosen, status }) => {
    const badge = { correct: '<span class="badge good">Correct</span>', incorrect: '<span class="badge bad">Incorrect</span>', skipped: '<span class="badge skip">Unanswered</span>' }[status];
    const opts = q.letters.map((L) => {
      const cls = L === q.answer ? 'correct' : L === chosen ? 'incorrect' : '';
      return `<li class="${cls}"><b>${L}.</b><span>${esc(q.options[L])}</span>${L === chosen ? '<span class="you">Your answer</span>' : ''}</li>`;
    }).join('');
    const others = q.letters.filter((L) => L !== q.answer && q.distractors[L]);
    const head = `<div class="review-head">
        <b>Q${i + 1}</b>${badge}
        <span class="tag">${esc(q.domainKey)}</span>
        ${q.subtopic ? `<span class="tag plain">${esc(q.subtopic)}</span>` : ''}
      </div>`;
    if (q.unavailable) {
      return `<article class="review-item">${head}
        <p class="muted">${esc(q.id)} is no longer in the bank as it was. ${chosen ? `You answered ${esc(chosen)}; the answer was ${esc(q.answer)}.` : `The answer was ${esc(q.answer)}.`}</p>
      </article>`;
    }
    return `<article class="review-item">
      ${head}
      <div class="stem" style="font-size:.98rem;margin-bottom:.4rem">${esc(q.stem)}</div>
      <ul class="review-options">${opts}</ul>
      <div class="explain">
        ${q.explanation ? `<p><b>Answer ${q.answer}:</b> ${esc(q.explanation)}</p>` : `<p><b>Answer: ${q.answer}</b></p>`}
        ${status === 'incorrect' && q.distractors[chosen] ? `<p><b>Why ${chosen} is wrong:</b> ${esc(q.distractors[chosen])}</p>` : ''}
        ${others.length ? `<details><summary>Why the other options are wrong</summary><ul>${others.map((L) => `<li><b>${L}:</b> ${esc(q.distractors[L])}</li>`).join('')}</ul></details>` : ''}
      </div>
    </article>`;
  }).join('');
}

/* =====================================================================
 * Test history
 * Each finished test is stored compactly: question ids and letters only.
 * Viewing one rebuilds it from the current bank.
 * ===================================================================== */

const KIND_LABELS = { new: 'New test', retake: 'Retake', missed: 'Missed practice' };

function attemptRecord(t, examId) {
  return {
    examId,
    kind: t.kind || 'new',
    startedAt: t.startedAt,
    endedAt: t.endedAt,
    feedback: t.feedback,
    allowSkip: t.allowSkip,
    shuffleOptions: t.shuffleOptions,
    questions: t.questions.map((q, i) => ({
      id: q.id,
      domain: q.domainKey,
      chosen: t.answers[i],
      answer: q.answer,
      ...(q.optionOrder ? { order: q.optionOrder } : {}),
    })),
  };
}

function recordAttempt(t) {
  state.attempts.push(attemptRecord(t, state.exam.id));
  state.attempts = state.attempts.slice(-MAX_ATTEMPTS);
  saveAttempts();
}

function attemptSummary(a) {
  const total = a.questions.length;
  const correct = a.questions.filter((r) => r.chosen === r.answer).length;
  const skipped = a.questions.filter((r) => r.chosen == null).length;
  return { total, correct, skipped, score: pct(correct, total) };
}

const examAttempts = () => state.attempts.filter((a) => a.examId === state.exam?.id);

// Rebuild a finished test from a stored attempt. Questions that have left the
// bank, or whose answer no longer matches, become placeholders that keep the score.
function restoreAttempt(a) {
  const bank = new Map(state.questions.map((q) => [q.id, q]));
  const questions = a.questions.map((r) => {
    const base = bank.get(r.id);
    const sameLetters = (o) => Array.isArray(o) && o.length === base.letters.length && [...o].sort().join() === base.letters.join();
    let q = base && (r.order ? sameLetters(r.order) && shuffleOptions(base, r.order) : base);
    if (!q || q.answer !== r.answer) {
      q = { id: r.id, domainKey: r.domain, subtopic: '', objective: '', stem: '', options: {}, letters: [], answer: r.answer, explanation: '', distractors: {}, unavailable: true };
    }
    return q;
  });
  const n = questions.length;
  return {
    kind: a.kind,
    questions,
    shuffleOptions: !!a.shuffleOptions,
    answers: a.questions.map((r) => r.chosen ?? null),
    locked: Array(n).fill(true),
    visited: Array(n).fill(true),
    current: 0,
    furthest: n - 1,
    allowSkip: a.allowSkip,
    feedback: a.feedback,
    startedAt: a.startedAt,
    endedAt: a.endedAt,
    fromHistory: true,
  };
}

function renderHistory() {
  stopTimer();
  state.test = null;
  const attempts = examAttempts();
  const summaries = attempts.map(attemptSummary);
  const scores = summaries.map((s) => s.score);
  const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
  const scoreBar = (p) => `<div class="bar"><span style="width:${p}%;background:${p >= 70 ? 'var(--good)' : 'var(--bad)'}"></span></div>`;

  // Domain totals across every recorded test for this exam.
  const byDomain = {};
  for (const a of attempts) for (const r of a.questions) {
    const d = (byDomain[r.domain] ||= { correct: 0, total: 0 });
    d.total++;
    if (r.chosen === r.answer) d.correct++;
  }
  const domainRows = state.exam.domains.filter((d) => byDomain[d.key]).map((d) => {
    const { correct, total } = byDomain[d.key];
    const p = pct(correct, total);
    return `<tr>
      <td><span class="dkey">${esc(d.key)}</span>${esc(d.name)}</td>
      <td class="num">${correct}/${total}</td>
      <td class="bar-cell">${scoreBar(p)}</td>
      <td class="num">${p}%</td>
    </tr>`;
  }).join('');

  const rows = attempts.map((a, i) => {
    const s = summaries[i];
    return `<tr>
      <td>${esc(formatDate(a.endedAt))}</td>
      <td>${esc(KIND_LABELS[a.kind] || KIND_LABELS.new)}</td>
      <td class="num">${s.correct}/${s.total}</td>
      <td class="bar-cell">${scoreBar(s.score)}</td>
      <td class="num">${s.score}%</td>
      <td class="num">${formatDuration(a.endedAt - a.startedAt)}</td>
      <td class="num"><button class="btn btn-sm" type="button" data-attempt="${i}">Review</button></td>
    </tr>`;
  }).reverse().join('');

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>Test history</h2>
        <button class="btn btn-sm" id="history-back" type="button">← Back</button>
      </div>
      ${attempts.length ? `
      <div class="stat-line">
        <div class="stat"><b>${attempts.length}</b><span>test${attempts.length === 1 ? '' : 's'} taken</span></div>
        <div class="stat"><b>${avg(scores)}%</b><span>average score</span></div>
        <div class="stat"><b>${Math.max(...scores)}%</b><span>best score</span></div>
        <div class="stat"><b>${avg(scores.slice(-5))}%</b><span>average of last ${Math.min(5, scores.length)}</span></div>
      </div>
      <table class="domain-table history-table">
        <thead><tr><th>Finished</th><th>Type</th><th class="num">Correct</th><th></th><th class="num">Score</th><th class="num">Time</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="row" style="margin-top:1rem">
        <span class="muted small">The last ${MAX_ATTEMPTS} finished tests are kept in this browser.</span>
        <span class="spacer"></span>
        <button class="btn btn-sm" id="clear-attempts" type="button">Clear test history</button>
      </div>` : '<div class="empty">No finished tests for this exam yet. Results are saved here each time you finish a test.</div>'}
    </section>
    ${domainRows ? `
    <section class="card">
      <h2>By domain, all tests</h2>
      <table class="domain-table">
        <thead><tr><th>Domain</th><th class="num">Correct</th><th></th><th class="num">Score</th></tr></thead>
        <tbody>${domainRows}</tbody>
      </table>
    </section>` : ''}`;

  $('#history-back').addEventListener('click', renderSetup);
  app().querySelectorAll('[data-attempt]').forEach((b) => b.addEventListener('click', () => {
    state.test = restoreAttempt(attempts[Number(b.dataset.attempt)]);
    state.reviewFilter = 'all';
    renderResults();
    window.scrollTo(0, 0);
  }));
  $('#clear-attempts')?.addEventListener('click', () => {
    if (!confirm(`Delete all ${attempts.length} saved test${attempts.length === 1 ? '' : 's'} for this exam? Your answer history used for question selection is kept.`)) return;
    state.attempts = state.attempts.filter((a) => a.examId !== state.exam.id);
    saveAttempts();
    renderHistory();
  });
  window.scrollTo(0, 0);
}

/* =====================================================================
 * Boot
 * ===================================================================== */

async function init() {
  initTheme();
  document.addEventListener('keydown', handleKey);

  if (location.protocol === 'file:') {
    renderFatal('Start the local server', `
      <p>Browsers don't let a page opened from disk read the question bank files.</p>
      <p>Double-click <b>start.bat</b> in this folder (or run <code>python -m http.server 47823</code>) and open
      <a href="http://localhost:47823">http://localhost:47823</a>.</p>`);
    return;
  }

  try {
    await loadExams();
  } catch (e) {
    renderFatal('Could not load exams.json', `<p class="muted">${esc(e.message)}</p>`);
    return;
  }
  const exam = state.exams.find((e) => e.id === state.settings.examId) || state.exams[0];
  state.settings.examId = exam.id;
  await loadExam(exam);
  renderSetup();
}

window.addEventListener('beforeunload', (e) => {
  if (state.test && !state.test.endedAt && state.test.answers.some((a) => a != null)) e.preventDefault();
});

init();
