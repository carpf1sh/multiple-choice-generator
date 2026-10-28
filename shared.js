'use strict';

/* =====================================================================
 * Shared by the practice app (app.js) and the test manager (manage.js):
 * storage, escaping, theme, and loading and validating question banks.
 * ===================================================================== */

const LETTERS = 'ABCDEFGHIJ';
const KEYS = { settings: 'mcq.settings', history: 'mcq.history', attempts: 'mcq.attempts', theme: 'mcq.theme' };

/* ---------- Storage (never throws; app works without it) ---------- */

const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* unavailable */ }
  },
};

/* ---------- Helpers ---------- */

const $ = (sel, root = document) => root.querySelector(sel);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* ---------- Theme ---------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  btn.textContent = theme === 'dark' ? '☀ Light theme' : '☾ Dark theme';
  btn.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
}

function initTheme() {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  $('#theme-toggle').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.set(KEYS.theme, next);
    applyTheme(next);
  });
}

/* ---------- Loading & normalising ---------- */

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText || 'error'}`);
  try { return await res.json(); } catch { throw new Error('invalid JSON'); }
}

function domainKeyFor(item, id) {
  const m = /-D(\d+)-/i.exec(id) || /Domain\s+(\d+)/i.exec(String(item.domain || ''));
  return m ? `D${Number(m[1])}` : null;
}

function normalize(item, file, index) {
  if (!item || typeof item !== 'object') return null;
  const stem = item.scenario_stem ?? item.question ?? item.stem;
  let options = item.options;
  if (Array.isArray(options)) options = Object.fromEntries(options.map((t, i) => [LETTERS[i], t]));
  if (!stem || !options || typeof options !== 'object') return null;

  options = Object.fromEntries(
    Object.entries(options)
      .filter(([, v]) => v != null && String(v).trim())
      .map(([k, v]) => [String(k).trim().toUpperCase(), String(v)])
  );
  // Keys are rendered as markup, so only single letters A–J are accepted.
  const letters = Object.keys(options).sort();
  if (letters.length < 2 || !letters.every((L) => L.length === 1 && LETTERS.includes(L))) return null;

  const answer = String(item.correct_option ?? item.answer ?? '').trim().toUpperCase();
  if (!letters.includes(answer)) return null;

  const exp = item.explanation;
  const distractors = {};
  if (exp && typeof exp === 'object' && exp.distractors && typeof exp.distractors === 'object') {
    for (const [k, v] of Object.entries(exp.distractors)) distractors[String(k).toUpperCase()] = String(v);
  }
  const id = String(item.id ?? `${file}#${index + 1}`);

  return {
    id,
    domainKey: domainKeyFor(item, id),
    domainLabel: String(item.domain || ''),
    subtopic: String(item.subtopic || item.topic || 'General'),
    objective: item.objective != null ? String(item.objective) : '',
    stem: String(stem),
    options,
    letters,
    answer,
    explanation: typeof exp === 'string' ? exp : String(exp?.correct ?? ''),
    distractors,
    file,
  };
}

const examList = (data) => (Array.isArray(data) ? data : (data && data.exams) || [])
  .filter((e) => e && e.id && e.manifest && Array.isArray(e.domains));

// exams.json ships with the repo; exams.local.json (git-ignored, optional) holds
// private exams. Local entries come first and override shared ones with the same id.
// Each exam is tagged with the registry it came from.
async function fetchExams() {
  const shared = examList(await fetchJson('exams.json')).map((e) => ({ ...e, source: 'shared' }));
  let local = [];
  try { local = examList(await fetchJson('exams.local.json')).map((e) => ({ ...e, source: 'local' })); } catch { /* optional */ }
  const localIds = new Set(local.map((e) => e.id));
  return [...local, ...shared.filter((e) => !localIds.has(e.id))];
}
