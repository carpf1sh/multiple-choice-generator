'use strict';

/* =====================================================================
 * Test manager
 * Create tests, add and remove questions, and reword questions and answers.
 * Reads the same files as the practice app and saves them back through
 * server.pyw's /api/files, which only runs on the local server.
 * ===================================================================== */

const MAX_OPTIONS = 10;
const MIN_OPTIONS = 2;
// Longest accepted text, in characters, for each field.
const LIMITS = {
  id: 40, name: 100, title: 120, domainName: 100, domains: 20, weight: 1000,
  stem: 5000, option: 1000, note: 2000, explanation: 5000, subtopic: 100, objective: 20,
};

const state = {
  exams: [],
  writable: false,
  banks: {},       // { [examId]: bank } from loadBank
  bank: null,      // the open test
  view: 'list',    // list | new | exam | edit
  filter: { domain: '', text: '' },
  newTest: null,   // new-test form
  form: null,      // question form
  entry: null,     // the bank entry being edited; null for a new question
  dirty: false,
  flash: '',
};

const app = () => $('#app');
const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/* =====================================================================
 * File editing (pure; covered by tests/manage.test.js)
 * ===================================================================== */

function slugify(name) {
  return String(name).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
}

// Puts the list back the way the batch file holds it (see questionsOf), and
// keeps the file's own item_count right when it has one.
function withQuestions(data, list) {
  if (!data || Array.isArray(data) || typeof data !== 'object') return list;
  const out = { ...data, [questionsKeyOf(data) || 'questions']: list };
  if ('item_count' in data) out.item_count = list.length;
  return out;
}

// Next free id like SAMPLE-D2-007. The domain is read from -D<n>- in the id
// first, so a prefix that would confuse that falls back to "Q".
function nextQuestionId(examId, domainKey, ids) {
  let prefix = String(examId).toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Q';
  if (domainKeyFor({}, `${prefix}-${domainKey}-001`) !== domainKey) prefix = 'Q';
  const re = new RegExp(`^${prefix}-${domainKey}-(\\d+)$`, 'i');
  const taken = new Set(ids.map(String));
  let n = Math.max(0, ...ids.map((id) => Number(re.exec(id)?.[1] || 0)));
  let id;
  do id = `${prefix}-${domainKey}-${String(++n).padStart(3, '0')}`; while (taken.has(id));
  return id;
}

// Builds the stored question from the editor form. Alternative field names
// (question, stem, answer, topic, array options) are replaced by the canonical
// ones; fields the app doesn't know about are kept.
function toRawQuestion(form, existing = {}, domainName = '') {
  const {
    id, domain, subtopic, topic, objective, scenario_stem, question, stem,
    options, correct_option, answer, explanation, ...rest
  } = existing;
  const letters = form.options.map((_, i) => LETTERS[i]);
  const keepDomain = typeof domain === 'string' && domain.trim() && domainKeyFor({ domain }, form.id) === form.domainKey;
  const distractors = {};
  form.options.forEach((o, i) => {
    if (i !== form.answer && o.why.trim()) distractors[letters[i]] = o.why.trim();
  });

  const raw = {
    id: form.id,
    domain: keepDomain ? domain : `Domain ${form.domainKey.slice(1)}: ${domainName}`,
    subtopic: form.subtopic.trim() || 'General',
  };
  if (form.objective.trim()) raw.objective = form.objective.trim();
  raw.scenario_stem = form.stem.trim();
  raw.options = Object.fromEntries(form.options.map((o, i) => [letters[i], o.text.trim()]));
  raw.correct_option = letters[form.answer];
  if (form.explanation.trim() || Object.keys(distractors).length) {
    raw.explanation = { correct: form.explanation.trim(), distractors };
  }
  return { ...raw, ...rest };
}

// Index of a question in a batch. Questions without an id are known by
// "<file>#<position>", the same id normalize() gives them.
function findQuestion(list, id, file) {
  const i = list.findIndex((item) => item && item.id != null && String(item.id) === id);
  if (i >= 0) return i;
  const pos = id.startsWith(`${file}#`) ? Number(id.slice(file.length + 1)) - 1 : -1;
  return pos >= 0 && list[pos] && list[pos].id == null ? pos : -1;
}

// Replaces the question with this id, or appends raw when id is null.
function upsertQuestion(data, raw, id, file) {
  const list = questionsOf(data).slice();
  if (id == null) list.push(raw);
  else {
    const i = findQuestion(list, id, file);
    if (i < 0) throw new Error(`${id} is no longer in ${file}. Reload and try again.`);
    list[i] = raw;
  }
  return withQuestions(data, list);
}

function removeQuestion(data, id, file) {
  const list = questionsOf(data).slice();
  const i = findQuestion(list, id, file);
  if (i < 0) throw new Error(`${id} is no longer in ${file}. Reload and try again.`);
  list.splice(i, 1);
  return withQuestions(data, list);
}

// Distinct valid question ids across batches ([{ file, data }]), as the app counts them.
function countQuestions(batches) {
  const ids = new Set();
  for (const { file, data } of batches) {
    questionsOf(data).forEach((item, i) => {
      const q = normalize(item, file, i);
      if (q) ids.add(q.id);
    });
  }
  return ids.size;
}

// Sets the batch's item_count (listing the batch if it's new) in every batch
// list the manifest has ("batches", "sets"), and the manifest's
// total_questions and total_sets, when it has them. Other fields are kept.
function updateManifestCounts(manifest, file, itemCount, total) {
  const out = { ...manifest };
  const keys = BATCH_KEYS.filter((k) => Array.isArray(manifest[k]));
  for (const key of keys.length ? keys : ['batches']) {
    const batches = (manifest[key] || []).slice();
    const i = batches.findIndex((b) => b && b.file_name === file);
    if (i < 0) batches.push({ batch_id: file.replace(/\.json$/i, ''), file_name: file, item_count: itemCount });
    else batches[i] = { ...batches[i], item_count: itemCount };
    out[key] = batches;
  }
  if ('total_questions' in manifest) out.total_questions = total;
  if ('total_sets' in manifest) out.total_sets = batchesOf(out).length;
  return out;
}

// Questions added here go to one batch next to the manifest:
// samples/sample_manifest.json → sample_added.json.
function addedBatchName(manifestPath) {
  const stem = manifestPath.split('/').pop().replace(/\.json$/i, '').replace(/[_-]?manifest$/i, '');
  return `${stem || 'questions'}_added.json`;
}

const tooLong = (label, text, limit) => (text.trim().length > limit ? `${label} is too long (${text.trim().length} of ${limit} characters).` : '');

function validateNewTest(t, exams) {
  if (!t.name.trim()) return 'Enter a name for the test.';
  if (!t.id) return 'Enter an id for the test.';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(t.id)) return 'The id may only use lowercase letters, digits and dashes, and must start with a letter or digit.';
  const long = tooLong('The name', t.name, LIMITS.name) || tooLong('The title', t.title, LIMITS.title)
    || tooLong('The id', t.id, LIMITS.id);
  if (long) return long;
  if (exams.some((e) => e.id === t.id)) return `A test with the id "${t.id}" already exists.`;
  if (!t.domains.length) return 'Add at least one domain.';
  if (t.domains.length > LIMITS.domains) return `A test can have at most ${LIMITS.domains} domains.`;
  const names = new Set();
  for (const [i, d] of t.domains.entries()) {
    const key = `D${i + 1}`, name = d.name.trim();
    if (!name) return `Domain ${key} needs a name.`;
    const longName = tooLong(`Domain ${key}'s name`, name, LIMITS.domainName);
    if (longName) return longName;
    if (names.has(name.toLowerCase())) return `Two domains are called "${name}".`;
    names.add(name.toLowerCase());
    // Number('') is 0 and Number('Infinity') passes "> 0", so check for a real, bounded number.
    const w = String(d.weight).trim() === '' ? NaN : Number(d.weight);
    if (!Number.isFinite(w) || w <= 0 || w > LIMITS.weight) return `Domain ${key} needs a weight above 0 and up to ${LIMITS.weight}.`;
  }
  return '';
}

// The files a new test needs: its registry entry, a manifest, and an empty batch.
// registry is the current registry file's contents, or null if it doesn't exist.
function newExamFiles(t, registry) {
  const dir = t.shared ? 'samples' : 'private';
  const manifestPath = `${dir}/${t.id}_manifest.json`;
  const batch = addedBatchName(manifestPath);
  const exam = {
    id: t.id,
    name: t.name.trim(),
    ...(t.title.trim() ? { title: t.title.trim() } : {}),
    manifest: manifestPath,
    domains: t.domains.map((d, i) => ({ key: `D${i + 1}`, name: d.name.trim(), weight: Number(d.weight) })),
  };
  const exams = Array.isArray(registry) ? registry : (registry && registry.exams) || [];
  const nextRegistry = Array.isArray(registry) ? [...exams, exam] : { ...(registry || {}), exams: [...exams, exam] };
  return {
    exam,
    files: [
      { path: t.shared ? 'exams.json' : 'exams.local.json', data: nextRegistry },
      { path: manifestPath, data: { manifest_version: '1.0', total_questions: 0, batches: [{ batch_id: batch.replace(/\.json$/, ''), file_name: batch, item_count: 0 }] } },
      { path: `${dir}/${batch}`, data: [] },
    ],
  };
}

function validateQuestion(form, exam, ids) {
  if (!exam.domains.some((d) => d.key === form.domainKey)) return `Domain ${form.domainKey} isn't registered for this test.`;
  if (!form.stem.trim()) return 'Enter the question text.';
  if (form.options.length < MIN_OPTIONS) return `A question needs at least ${MIN_OPTIONS} options.`;
  if (form.options.length > MAX_OPTIONS) return `A question can have at most ${MAX_OPTIONS} options.`;
  const empty = form.options.findIndex((o) => !o.text.trim());
  if (empty >= 0) return `Option ${LETTERS[empty]} is empty.`;
  const seen = new Map();
  for (const [i, o] of form.options.entries()) {
    const text = o.text.trim().toLowerCase();
    if (seen.has(text)) return `Options ${LETTERS[seen.get(text)]} and ${LETTERS[i]} are the same.`;
    seen.set(text, i);
  }
  if (!(form.answer >= 0 && form.answer < form.options.length)) return 'Choose the correct answer.';
  const long = tooLong('The question', form.stem, LIMITS.stem)
    || tooLong('The subtopic', form.subtopic, LIMITS.subtopic)
    || tooLong('The objective', form.objective, LIMITS.objective)
    || tooLong('The explanation', form.explanation, LIMITS.explanation)
    || form.options.map((o, i) => tooLong(`Option ${LETTERS[i]}`, o.text, LIMITS.option)
      || (i !== form.answer && tooLong(`The note for option ${LETTERS[i]}`, o.why, LIMITS.note))).find(Boolean);
  if (long) return long;
  const id = form.id ?? nextQuestionId(exam.id, form.domainKey, ids);
  const raw = toRawQuestion({ ...form, id }, {}, '');
  const q = normalize(raw, '', 0);
  if (!q) return 'This question would not pass validation.';
  if (q.domainKey !== form.domainKey) return `The id ${id} places this question in ${q.domainKey}.`;
  return '';
}

/* =====================================================================
 * Loading & saving
 * ===================================================================== */

async function checkWritable() {
  try { return (await fetchJson('api/status')).writable === true; } catch { return false; }
}

async function saveFiles(files) {
  const res = await fetch('api/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText || 'error'}`;
    try { msg = (await res.json()).error || msg; } catch { /* not JSON */ }
    throw new Error(msg);
  }
}

// Like the app's loadExam, but keeps each question's raw form and file so it can be written back.
async function loadBank(exam) {
  const bank = { exam, base: dirOf(exam.manifest), batches: [], entries: [], warnings: [] };
  let manifest;
  try {
    manifest = await fetchJson(exam.manifest);
  } catch (e) {
    bank.warnings.push(`Could not load manifest "${exam.manifest}": ${e.message}`);
    return bank;
  }
  const files = batchesOf(manifest).map((b) => b && b.file_name).filter(Boolean);
  const results = await Promise.allSettled(files.map((f) => fetchJson(bank.base + f)));
  results.forEach((r, i) => {
    const file = files[i];
    if (r.status === 'rejected') { bank.warnings.push(`${file}: ${r.reason.message}`); return; }
    bank.batches.push({ file, data: r.value });
    let bad = 0;
    questionsOf(r.value).forEach((raw, index) => {
      const q = normalize(raw, file, index);
      if (q) bank.entries.push({ q, raw, file, index }); else bad++;
    });
    if (bad) bank.warnings.push(`${file}: ${plural(bad, 'invalid question')} can't be edited here.`);
  });

  const counts = groupCount(bank.entries.map((e) => e.q.id));
  const dupes = [...counts.values()].filter((n) => n > 1).length;
  if (dupes) bank.warnings.push(`${plural(dupes, 'question id')} appear${dupes === 1 ? 's' : ''} in more than one batch; the practice app uses the last one.`);
  const known = new Set(exam.domains.map((d) => d.key));
  const unknown = bank.entries.filter((e) => !known.has(e.q.domainKey)).length;
  if (unknown) bank.warnings.push(`${plural(unknown, 'question')} ${unknown === 1 ? 'has' : 'have'} a domain that isn't registered for this test.`);
  return bank;
}

function groupCount(xs) {
  const m = new Map();
  for (const x of xs) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

// The batch and manifest writes for one changed batch file.
function bankWrite(bank, manifest, file, data) {
  const batches = bank.batches.some((b) => b.file === file)
    ? bank.batches.map((b) => (b.file === file ? { file, data } : b))
    : [...bank.batches, { file, data }];
  const nextManifest = updateManifestCounts(manifest, file, questionsOf(data).length, countQuestions(batches));
  return [{ path: bank.base + file, data }, { path: bank.exam.manifest, data: nextManifest }];
}

async function reloadBank(message) {
  const exam = state.bank.exam;
  state.bank = state.banks[exam.id] = await loadBank(exam);
  state.flash = message;
  renderExam();
}

/* =====================================================================
 * Screens
 * ===================================================================== */

function renderFatal(title, html) {
  app().innerHTML = `<div class="card"><h2>${esc(title)}</h2>${html}</div>`;
}

const readOnlyNotice = () => (state.writable ? '' : `
  <div class="notice notice-warn">Editing needs the local server. Run <b>start.bat</b> (or <code>python server.pyw</code>)
  and open this page from <code>localhost</code>. You can look around here, but changes can't be saved.</div>`);

const flashNotice = () => {
  const msg = state.flash;
  state.flash = '';
  return msg ? `<div class="notice notice-good" role="status">${esc(msg)}</div>` : '';
};

/* ---------- Test list ---------- */

async function showList() {
  state.view = 'list';
  app().innerHTML = '<div class="loading">Loading tests…</div>';
  const banks = await Promise.all(state.exams.map(loadBank));
  banks.forEach((b) => { state.banks[b.exam.id] = b; });
  renderList();
}

function renderList() {
  state.view = 'list';
  const rows = state.exams.map((e) => `<tr>
      <td><b>${esc(e.name)}</b><div class="muted small">${esc(e.id)}</div></td>
      <td>${e.source === 'local' ? 'Private' : 'Shared'}</td>
      <td class="num">${e.domains.length}</td>
      <td class="num">${state.banks[e.id]?.entries.length ?? '–'}</td>
      <td class="num"><button class="btn btn-sm" type="button" data-open="${esc(e.id)}">Open</button></td>
    </tr>`).join('');

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>Tests</h2>
        <button class="btn btn-primary btn-sm" id="new-test" type="button" ${state.writable ? '' : 'disabled'}>+ New test</button>
      </div>
      ${readOnlyNotice()}
      ${flashNotice()}
      ${state.exams.length ? `
      <table class="domain-table">
        <thead><tr><th>Test</th><th>Stored</th><th class="num">Domains</th><th class="num">Questions</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No tests yet. Create one to get started.</div>'}
    </section>`;

  $('#new-test').addEventListener('click', () => {
    state.newTest = { name: '', title: '', id: '', idEdited: false, domains: [{ name: '', weight: 1 }], shared: false };
    renderNewTest();
  });
  app().querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => {
    state.bank = state.banks[b.dataset.open];
    state.filter = { domain: '', text: '' };
    renderExam();
  }));
  window.scrollTo(0, 0);
}

/* ---------- New test ---------- */

function renderNewTest() {
  state.view = 'new';
  const t = state.newTest;
  const domainRows = t.domains.map((d, i) => `
    <div class="row domain-row">
      <span class="dkey">D${i + 1}</span>
      <input type="text" data-domain-name="${i}" value="${esc(d.name)}" placeholder="Domain name" aria-label="Domain D${i + 1} name">
      <input type="number" data-domain-weight="${i}" value="${esc(d.weight)}" min="0" step="1" aria-label="Domain D${i + 1} weight">
      <button class="btn btn-sm" type="button" data-remove-domain="${i}" ${t.domains.length > 1 ? '' : 'disabled'} aria-label="Remove domain D${i + 1}">✕</button>
    </div>`).join('');

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>New test</h2>
        <button class="btn btn-sm" id="cancel" type="button">← Back</button>
      </div>
      <div class="form-stack">
        <div class="grid-2">
          <div>
            <label class="field" for="t-name">Name</label>
            <input type="text" id="t-name" value="${esc(t.name)}" placeholder="e.g. Networking Basics">
            <div class="field-help">Shown in the exam picker.</div>
          </div>
          <div>
            <label class="field" for="t-id">Id</label>
            <input type="text" id="t-id" value="${esc(t.id)}" placeholder="networking-basics">
            <div class="field-help">Lowercase letters, digits and dashes. Used in file names and question ids.</div>
          </div>
        </div>
        <div>
          <label class="field" for="t-title">Title <span class="muted small">(optional)</span></label>
          <input type="text" id="t-title" value="${esc(t.title)}" placeholder="Defaults to &quot;&lt;name&gt; Practice Test&quot;">
        </div>
        <div>
          <span class="field">Domains and weights</span>
          <div class="domain-rows">${domainRows}</div>
          <button class="btn btn-sm" id="add-domain" type="button" style="margin-top:.5rem">+ Add domain</button>
          <div class="field-help">Weights are relative and don't need to add up to 100.</div>
        </div>
        <div>
          <span class="field">Stored</span>
          <div class="segmented" role="radiogroup" aria-label="Stored">
            <label><input type="radio" name="shared" value="private" ${t.shared ? '' : 'checked'}>Private</label>
            <label><input type="radio" name="shared" value="shared" ${t.shared ? 'checked' : ''}>Shared</label>
          </div>
          <div class="field-help" id="stored-help"></div>
        </div>
        <div id="form-error" class="notice notice-bad" role="alert" hidden></div>
        <div class="row">
          <span class="spacer"></span>
          <button class="btn btn-primary" id="create-test" type="button">Create test</button>
        </div>
      </div>
    </section>`;

  const storedHelp = () => {
    $('#stored-help').textContent = t.shared
      ? `Added to exams.json, with files in samples/. Committed to git.`
      : `Added to exams.local.json, with files in private/. Both are git-ignored.`;
  };
  storedHelp();

  $('#t-name').addEventListener('input', (e) => {
    t.name = e.target.value;
    if (!t.idEdited) $('#t-id').value = t.id = slugify(t.name);
  });
  $('#t-id').addEventListener('input', (e) => { t.id = e.target.value.trim(); t.idEdited = true; });
  $('#t-title').addEventListener('input', (e) => { t.title = e.target.value; });
  app().querySelectorAll('[data-domain-name]').forEach((el) => el.addEventListener('input', () => { t.domains[el.dataset.domainName].name = el.value; }));
  app().querySelectorAll('[data-domain-weight]').forEach((el) => el.addEventListener('input', () => { t.domains[el.dataset.domainWeight].weight = el.value; }));
  app().querySelectorAll('[data-remove-domain]').forEach((b) => b.addEventListener('click', () => {
    t.domains.splice(Number(b.dataset.removeDomain), 1);
    renderNewTest();
  }));
  $('#add-domain').addEventListener('click', () => { t.domains.push({ name: '', weight: 1 }); renderNewTest(); });
  app().querySelectorAll('input[name="shared"]').forEach((r) => r.addEventListener('change', () => { t.shared = r.value === 'shared'; storedHelp(); }));
  $('#cancel').addEventListener('click', renderList);
  $('#create-test').addEventListener('click', (e) => createTest(e.target));
}

async function createTest(button) {
  const t = state.newTest;
  const showError = (msg) => { const el = $('#form-error'); el.textContent = msg; el.hidden = !msg; };
  const err = validateNewTest(t, state.exams);
  if (err) return showError(err);

  button.disabled = true;
  button.textContent = 'Creating…';
  try {
    const registryPath = t.shared ? 'exams.json' : 'exams.local.json';
    let registry = null;
    try { registry = await fetchJson(registryPath); } catch (e) { if (t.shared) throw e; }
    const { exam, files } = newExamFiles(t, registry);
    for (const f of files.slice(1)) {
      const exists = await fetch(f.path, { method: 'HEAD', cache: 'no-store' }).then((r) => r.ok, () => false);
      if (exists) throw new Error(`${f.path} already exists. Pick another id.`);
    }
    await saveFiles(files);
    state.exams = await fetchExams();
    const created = state.exams.find((e) => e.id === exam.id) || { ...exam, source: t.shared ? 'shared' : 'local' };
    state.bank = state.banks[created.id] = await loadBank(created);
    state.filter = { domain: '', text: '' };
    state.flash = `Created ${exam.name}. Add its first question below.`;
    renderExam();
  } catch (e) {
    showError(`Couldn't create the test: ${e.message}`);
    button.disabled = false;
    button.textContent = 'Create test';
  }
}

/* ---------- One test's questions ---------- */

function renderExam() {
  state.view = 'exam';
  const { exam, entries, warnings, batches } = state.bank;
  const f = state.filter;

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${esc(exam.name)}</h2>
        <div class="row">
          <button class="btn btn-sm" id="to-list" type="button">← All tests</button>
          <button class="btn btn-primary btn-sm" id="add-question" type="button" ${state.writable && exam.domains.length ? '' : 'disabled'}>+ Add question</button>
        </div>
      </div>
      <div class="stat-line">
        <div class="stat"><b>${entries.length}</b><span>questions</span></div>
        <div class="stat"><b>${batches.length}</b><span>batch${batches.length === 1 ? '' : 'es'}</span></div>
        <div class="stat"><b>${exam.source === 'local' ? 'Private' : 'Shared'}</b><span>${esc(exam.manifest)}</span></div>
      </div>
      ${readOnlyNotice()}
      ${flashNotice()}
      ${warnings.length ? `<div class="notice notice-warn"><b>Heads up</b><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
    </section>

    <section class="card">
      <div class="row filter-bar">
        <select id="f-domain" aria-label="Domain">
          <option value="">All domains</option>
          ${exam.domains.map((d) => `<option value="${esc(d.key)}" ${d.key === f.domain ? 'selected' : ''}>${esc(d.key)} · ${esc(d.name)}</option>`).join('')}
        </select>
        <input type="search" id="f-text" value="${esc(f.text)}" placeholder="Search questions" aria-label="Search questions">
      </div>
      <div id="question-rows"></div>
    </section>`;

  renderQuestionRows();
  $('#f-domain').addEventListener('change', (e) => { f.domain = e.target.value; renderQuestionRows(); });
  $('#f-text').addEventListener('input', (e) => { f.text = e.target.value; renderQuestionRows(); });
  $('#to-list').addEventListener('click', renderList);
  $('#add-question').addEventListener('click', () => openEditor(null));
  window.scrollTo(0, 0);
}

function renderQuestionRows() {
  const { entries } = state.bank, f = state.filter;
  const text = f.text.trim().toLowerCase();
  const matches = (e) => [e.q.id, e.q.stem, e.q.subtopic, ...Object.values(e.q.options)].some((s) => s.toLowerCase().includes(text));
  const shown = entries
    .map((e, i) => [e, i])
    .filter(([e]) => (!f.domain || e.q.domainKey === f.domain) && (!text || matches(e)));
  const el = $('#question-rows');
  if (!shown.length) {
    el.innerHTML = `<div class="empty">${entries.length ? 'No questions match.' : 'No questions yet.'}</div>`;
    return;
  }
  const preview = (s) => (s.length > 160 ? `${s.slice(0, 157)}…` : s);
  el.innerHTML = `
    <table class="domain-table q-table">
      <thead><tr><th>Question</th><th>Domain</th><th>Subtopic</th><th></th></tr></thead>
      <tbody>${shown.map(([e, i]) => `<tr>
        <td>${esc(preview(e.q.stem))}<div class="muted small">${esc(e.q.id)} · ${esc(e.file)}</div></td>
        <td><span class="dkey">${esc(e.q.domainKey)}</span></td>
        <td>${esc(e.q.subtopic)}</td>
        <td class="num nowrap">
          <button class="btn btn-sm" type="button" data-edit="${i}">${state.writable ? 'Edit' : 'View'}</button>
          ${state.writable ? `<button class="btn btn-sm" type="button" data-remove="${i}">Remove</button>` : ''}
        </td>
      </tr>`).join('')}</tbody>
    </table>`;
  el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openEditor(entries[Number(b.dataset.edit)])));
  el.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', () => removeEntry(entries[Number(b.dataset.remove)], b)));
}

async function removeEntry(entry, button) {
  if (!confirm(`Remove ${entry.q.id} from ${entry.file}? This rewrites the file and can't be undone here.`)) return;
  const bank = state.bank;
  button.disabled = true;
  try {
    const [manifest, data] = await Promise.all([fetchJson(bank.exam.manifest), fetchJson(bank.base + entry.file)]);
    await saveFiles(bankWrite(bank, manifest, entry.file, removeQuestion(data, entry.q.id, entry.file)));
    await reloadBank(`Removed ${entry.q.id}.`);
  } catch (e) {
    alert(`Couldn't remove the question: ${e.message}`);
    button.disabled = false;
  }
}

/* ---------- Question editor ---------- */

const blankOption = () => ({ text: '', why: '' });

function openEditor(entry) {
  const exam = state.bank.exam;
  if (entry) {
    const q = entry.q;
    state.form = {
      id: q.id,
      domainKey: q.domainKey,
      subtopic: q.subtopic,
      objective: q.objective,
      stem: q.stem,
      options: q.letters.map((L) => ({ text: q.options[L], why: q.distractors[L] || '' })),
      answer: q.letters.indexOf(q.answer),
      explanation: q.explanation,
    };
  } else {
    const domainKey = exam.domains.some((d) => d.key === state.filter.domain) ? state.filter.domain : exam.domains[0].key;
    state.form = {
      id: null, domainKey, subtopic: '', objective: '', stem: '',
      options: [blankOption(), blankOption(), blankOption(), blankOption()], answer: 0, explanation: '',
    };
  }
  state.entry = entry;
  state.dirty = false;
  renderEditor();
  window.scrollTo(0, 0);
}

function renderEditor() {
  state.view = 'edit';
  const form = state.form, entry = state.entry, exam = state.bank.exam;
  const ro = !state.writable;
  // The domain comes from -D<n>- in the id when there is one, so it can't change without a new id.
  const lockedDomain = ro || (entry && /-D\d+-/i.test(entry.q.id));

  const optionRows = form.options.map((o, i) => `
    <div class="opt-row ${i === form.answer ? 'is-answer' : ''}">
      <label class="opt-pick" title="Correct answer">
        <input type="radio" name="answer" value="${i}" ${i === form.answer ? 'checked' : ''} ${ro ? 'disabled' : ''}>${LETTERS[i]}
      </label>
      <div class="opt-fields">
        <textarea rows="2" data-opt-text aria-label="Option ${LETTERS[i]}" placeholder="Option text" ${ro ? 'readonly' : ''}>${esc(o.text)}</textarea>
        <input type="text" data-opt-why value="${esc(o.why)}" aria-label="Why option ${LETTERS[i]} is wrong"
          placeholder="${i === form.answer ? 'Correct answer' : 'Why this option is wrong (optional)'}" ${i === form.answer || ro ? 'disabled' : ''}>
      </div>
      <button class="btn btn-sm" type="button" data-remove-opt="${i}" ${ro || form.options.length <= MIN_OPTIONS ? 'disabled' : ''} aria-label="Remove option ${LETTERS[i]}">✕</button>
    </div>`).join('');

  app().innerHTML = `
    <section class="card">
      <div class="card-head">
        <h2>${entry ? (ro ? 'Question' : 'Edit question') : 'New question'}</h2>
        <button class="btn btn-sm" id="cancel" type="button">← Back</button>
      </div>
      <div class="muted small" style="margin-bottom:1rem">${entry ? `${esc(entry.q.id)} · ${esc(entry.file)}` : `${esc(exam.name)} · saved to ${esc(addedBatchName(exam.manifest))}`}</div>
      ${readOnlyNotice()}
      <div class="form-stack">
        <div class="grid-2">
          <div>
            <label class="field" for="q-domain">Domain</label>
            <select id="q-domain" ${lockedDomain ? 'disabled' : ''}>
              ${exam.domains.map((d) => `<option value="${esc(d.key)}" ${d.key === form.domainKey ? 'selected' : ''}>${esc(d.key)} · ${esc(d.name)}</option>`).join('')}
            </select>
            ${lockedDomain && !ro ? '<div class="field-help">Set by the question id.</div>' : ''}
          </div>
          <div class="grid-2 tight">
            <div>
              <label class="field" for="q-subtopic">Subtopic</label>
              <input type="text" id="q-subtopic" value="${esc(form.subtopic)}" placeholder="General" ${ro ? 'readonly' : ''}>
            </div>
            <div>
              <label class="field" for="q-objective">Objective</label>
              <input type="text" id="q-objective" value="${esc(form.objective)}" placeholder="e.g. 1.2" ${ro ? 'readonly' : ''}>
            </div>
          </div>
        </div>
        <div>
          <label class="field" for="q-stem">Question</label>
          <textarea id="q-stem" rows="5" ${ro ? 'readonly' : ''}>${esc(form.stem)}</textarea>
        </div>
        <div>
          <span class="field">Answer options <span class="muted small">(select the correct one)</span></span>
          <div class="opt-list">${optionRows}</div>
          ${ro ? '' : `<button class="btn btn-sm" id="add-opt" type="button" style="margin-top:.5rem" ${form.options.length >= MAX_OPTIONS ? 'disabled' : ''}>+ Add option</button>`}
        </div>
        <div>
          <label class="field" for="q-explanation">Explanation <span class="muted small">(why the correct answer is right)</span></label>
          <textarea id="q-explanation" rows="3" ${ro ? 'readonly' : ''}>${esc(form.explanation)}</textarea>
        </div>
        <div id="change-warning" class="notice notice-warn" hidden>
          The correct answer or the number of options changed. Past tests that included this question keep their score,
          but will show it as changed and leave it out of retakes.
        </div>
        <div id="form-error" class="notice notice-bad" role="alert" hidden></div>
        ${ro ? '' : `<div class="row">
          <span class="spacer"></span>
          <button class="btn" id="cancel-2" type="button">Cancel</button>
          <button class="btn btn-primary" id="save" type="button">Save question</button>
        </div>`}
      </div>
    </section>`;

  bindEditor();
}

function readForm() {
  const f = state.form;
  // A locked select may not list the question's domain, and would report its first option instead.
  if (!$('#q-domain').disabled) f.domainKey = $('#q-domain').value;
  f.subtopic = $('#q-subtopic').value;
  f.objective = $('#q-objective').value;
  f.stem = $('#q-stem').value;
  f.explanation = $('#q-explanation').value;
  f.options = [...app().querySelectorAll('.opt-row')].map((row) => ({
    text: $('[data-opt-text]', row).value,
    why: $('[data-opt-why]', row).value,
  }));
  const checked = $('input[name="answer"]:checked');
  f.answer = checked ? Number(checked.value) : -1;
}

// Errors show once the form has been changed, so Save is never disabled without a reason.
function updateEditorStatus() {
  const f = state.form, entry = state.entry;
  const err = validateQuestion(f, state.bank.exam, state.bank.entries.map((e) => e.q.id));
  const errEl = $('#form-error');
  errEl.textContent = err;
  errEl.hidden = !(err && state.dirty);
  $('#save').disabled = !!err;
  $('#change-warning').hidden = !entry
    || (f.options.length === entry.q.letters.length && LETTERS[f.answer] === entry.q.answer);
  app().querySelectorAll('.opt-row').forEach((row, i) => {
    row.classList.toggle('is-answer', i === f.answer);
    const why = $('[data-opt-why]', row);
    why.disabled = i === f.answer;
    why.placeholder = i === f.answer ? 'Correct answer' : 'Why this option is wrong (optional)';
  });
}

function leaveEditor() {
  if (state.dirty && !confirm('Discard your changes to this question?')) return;
  state.dirty = false;
  renderExam();
}

function bindEditor() {
  $('#cancel').addEventListener('click', leaveEditor);
  if (!state.writable) return;
  $('#cancel-2').addEventListener('click', leaveEditor);
  const changed = () => { readForm(); state.dirty = true; updateEditorStatus(); };
  app().querySelectorAll('.form-stack input, .form-stack textarea, .form-stack select')
    .forEach((el) => el.addEventListener(el.type === 'radio' || el.tagName === 'SELECT' ? 'change' : 'input', changed));
  app().querySelectorAll('[data-remove-opt]').forEach((b) => b.addEventListener('click', () => {
    readForm();
    const i = Number(b.dataset.removeOpt), f = state.form;
    f.options.splice(i, 1);
    if (f.answer === i) f.answer = -1;
    else if (f.answer > i) f.answer--;
    state.dirty = true;
    renderEditor();
  }));
  $('#add-opt').addEventListener('click', () => {
    readForm();
    state.form.options.push(blankOption());
    state.dirty = true;
    renderEditor();
    const boxes = app().querySelectorAll('[data-opt-text]');
    boxes[boxes.length - 1].focus();
  });
  $('#save').addEventListener('click', (e) => saveQuestion(e.target));
  updateEditorStatus();
}

async function saveQuestion(button) {
  readForm();
  const form = state.form, entry = state.entry, bank = state.bank, exam = bank.exam;
  const ids = bank.entries.map((e) => e.q.id);
  if (validateQuestion(form, exam, ids)) return updateEditorStatus();

  const file = entry ? entry.file : addedBatchName(exam.manifest);
  const id = entry ? entry.q.id : nextQuestionId(exam.id, form.domainKey, ids);
  const domain = exam.domains.find((d) => d.key === form.domainKey);
  const raw = toRawQuestion({ ...form, id }, entry ? entry.raw : {}, domain ? domain.name : '');

  button.disabled = true;
  button.textContent = 'Saving…';
  try {
    // Re-read the files so changes made since the page loaded aren't lost.
    const manifest = await fetchJson(exam.manifest);
    const listed = batchesOf(manifest).some((b) => b && b.file_name === file);
    let data = [];
    try { data = await fetchJson(bank.base + file); } catch (e) { if (entry || listed) throw e; }
    await saveFiles(bankWrite(bank, manifest, file, upsertQuestion(data, raw, entry ? entry.q.id : null, file)));
    state.dirty = false;
    await reloadBank(`${entry ? 'Saved' : 'Added'} ${id}.`);
  } catch (e) {
    const errEl = $('#form-error');
    errEl.textContent = `Couldn't save: ${e.message}`;
    errEl.hidden = false;
    button.disabled = false;
    button.textContent = 'Save question';
  }
}

/* =====================================================================
 * Boot
 * ===================================================================== */

async function init() {
  initTheme();

  if (location.protocol === 'file:') {
    renderFatal('Start the local server', `
      <p>Browsers don't let a page opened from disk read or save the question bank files.</p>
      <p>Double-click <b>start.bat</b> in this folder (or run <code>python server.pyw</code>) and open
      <a href="http://localhost:47823/manage.html">http://localhost:47823/manage.html</a>.</p>`);
    return;
  }

  try {
    state.exams = await fetchExams();
  } catch (e) {
    renderFatal('Could not load exams.json', `<p class="muted">${esc(e.message)}</p>`);
    return;
  }
  state.writable = await checkWritable();
  await showList();
}

window.addEventListener('beforeunload', (e) => {
  if (state.view === 'edit' && state.dirty) e.preventDefault();
});

init();
