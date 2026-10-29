'use strict';

// Writes synthetic test history for the sample exams, so the Test history and
// Performance screens have something to show on the online demo. The app offers
// to load it ("Load demo history") when an exam has no saved tests.
//
//   node tools/demo-history.js
//
// Each exam gets a learner profile: a starting and ending accuracy per domain,
// plus offsets for subtopics that are harder or easier than their domain. The
// output is deterministic (seeded), so rerunning it after editing a bank only
// changes what the bank changed. Re-run it whenever the sample banks change.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const END = Date.UTC(2026, 9, 28, 19, 0); // the app shifts every date so the latest test is recent

const PROFILES = [
  {
    // Mixed results: one domain improving, one strong, one slipping, one weak,
    // and a subtopic never practised, so every status and trend shows up.
    examId: 'sample',
    file: 'samples/sample_demo_history.json',
    seed: 7,
    days: 42,
    domains: {
      D1: [0.35, 0.95], // Networking: improving
      D2: [0.88, 0.94], // Security: strong
      D3: [0.84, 0.48], // Programming: slipping
      D4: [0.52, 0.6],  // Databases: weak
    },
    subtopics: {
      'IPv4 Subnetting': -0.2,
      'Routing Protocols': -0.1,
      Recursion: -0.2,
      'Object-Oriented Design': -0.15,
      'Version Control': 0.15,
      Normalization: -0.2,
      'SQL Injection': 0.3,
    },
    skip: ['Indexing'],
    plan: ['new', 'new', 'missed', 'new', 'new', 'retake', 'new', 'new', 'missed', 'new',
      'new', 'new', 'retake', 'new', 'new', 'missed', 'new', 'new'],
  },
  {
    // Passing everywhere, so the Performance screen shows its "most left to gain" view.
    examId: 'cloud-sample',
    file: 'samples/cloud_demo_history.json',
    seed: 11,
    days: 24,
    domains: {
      D1: [0.78, 0.94],
      D2: [0.72, 0.9],
      D3: [0.74, 0.84],
    },
    subtopics: {
      'Compliance Frameworks': -0.05,
      'Shared Responsibility Model': -0.1,
      'Pricing Models': 0.1,
    },
    skip: [],
    plan: ['new', 'new', 'missed', 'new', 'new', 'retake', 'new', 'new', 'new', 'new'],
  },
];

// mulberry32: small seeded PRNG so the output is reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadBank(exam) {
  const manifest = readJson(exam.manifest);
  const dir = path.posix.dirname(exam.manifest);
  return manifest.batches.flatMap((b) => {
    const data = readJson(path.posix.join(dir, b.file_name));
    return (Array.isArray(data) ? data : data.questions).map((q) => ({
      id: q.id,
      domain: `D${/-D(\d+)-/.exec(q.id)[1]}`,
      subtopic: q.subtopic,
      letters: Object.keys(q.options).sort(),
      answer: q.correct_option,
    }));
  });
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

function generate(profile, exam) {
  const random = rng(profile.seed);
  const pick = (xs) => xs[Math.floor(random() * xs.length)];
  const shuffle = (xs) => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  const bank = loadBank(exam).filter((q) => !profile.skip.includes(q.subtopic));
  const weightSum = exam.domains.reduce((s, d) => s + d.weight, 0);
  const seen = new Map(bank.map((q) => [q.id, 0]));

  // A new test: questions split by exam weight, least-seen first.
  const newTest = (count) => exam.domains.flatMap((d) => {
    const n = Math.max(1, Math.round((count * d.weight) / weightSum));
    const pool = shuffle(bank.filter((q) => q.domain === d.key)).sort((a, b) => seen.get(a.id) - seen.get(b.id));
    return pool.slice(0, n);
  });

  // Each subtopic's right answers track its accuracy closely (error diffusion
  // rather than a coin flip per question), so the trends read clearly.
  const carry = {};
  const n = profile.plan.length;
  const attempts = [];
  let last = null;
  profile.plan.forEach((kind, i) => {
    const progress = n > 1 ? i / (n - 1) : 1;
    let questions;
    if (kind === 'retake' && last) questions = last.map((r) => bank.find((q) => q.id === r.id));
    else if (kind === 'missed' && last) questions = last.filter((r) => r.chosen !== r.answer).map((r) => bank.find((q) => q.id === r.id));
    if (!questions || questions.length < 3) {
      kind = 'new';
      questions = newTest(15 + Math.floor(random() * 3) * 5);
    }
    questions = shuffle(questions);

    // Practising the same questions again helps a little.
    const bonus = kind === 'new' ? 0 : 0.08;
    const records = questions.map((q) => {
      seen.set(q.id, seen.get(q.id) + 1);
      const [from, to] = profile.domains[q.domain];
      const p = Math.min(0.98, Math.max(0.05, from + (to - from) * progress + (profile.subtopics[q.subtopic] || 0) + bonus));
      carry[q.subtopic] = (carry[q.subtopic] ?? random() - 0.5) + p + (random() - 0.5) * 0.3;
      const right = carry[q.subtopic] >= 0.5;
      if (right) carry[q.subtopic] -= 1;
      const wrong = q.letters.filter((l) => l !== q.answer);
      const chosen = right ? q.answer : random() < 0.12 ? null : pick(wrong);
      return { id: q.id, domain: q.domain, subtopic: q.subtopic, chosen, answer: q.answer, order: shuffle(q.letters) };
    });

    // Spread tests over the period, a little unevenly, ending at END.
    const day = Math.round(profile.days * (1 - progress) + (random() - 0.5) * 1.5);
    // A retake or missed practice follows its test closely, so dates stay in order.
    const prev = attempts.at(-1)?.endedAt ?? -Infinity;
    const endedAt = Math.min(END, Math.max(prev + (1 + Math.floor(random() * 3)) * HOUR,
      END - Math.max(0, day) * DAY - Math.floor(random() * 10) * HOUR));
    const secondsEach = 35 + random() * 45;
    attempts.push({
      examId: exam.id,
      kind,
      startedAt: Math.round(endedAt - records.length * secondsEach * 1000),
      endedAt,
      feedback: random() < 0.6 ? 'immediate' : 'end',
      allowSkip: true,
      shuffleOptions: true,
      questions: records,
    });
    last = records;
  });
  return attempts;
}

const exams = readJson('exams.json').exams;
for (const profile of PROFILES) {
  const exam = exams.find((e) => e.id === profile.examId);
  if (!exam) throw new Error(`${profile.examId} isn't in exams.json`);
  const attempts = generate(profile, exam);
  // One attempt per line keeps the file readable and its diffs small.
  const body = attempts.map((a) => `  ${JSON.stringify(a)}`).join(',\n');
  fs.writeFileSync(path.join(ROOT, profile.file), `[\n${body}\n]\n`);
  console.log(`${profile.file}: ${attempts.length} tests`);
}
