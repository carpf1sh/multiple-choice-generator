# Practice Test App

[![CI](https://github.com/carpf1sh/multiple-choice-generator/actions/workflows/ci.yml/badge.svg)](https://github.com/carpf1sh/multiple-choice-generator/actions/workflows/ci.yml) [![CodeQL](https://github.com/carpf1sh/multiple-choice-generator/actions/workflows/codeql.yml/badge.svg)](https://github.com/carpf1sh/multiple-choice-generator/actions/workflows/codeql.yml)

A local, browser-based multiple-choice practice test generator. It builds tests of 1–200 questions from JSON question banks, weighted to match an exam's domain distribution and spread across subtopics. It picks up new question batches automatically as they're added to a manifest, so it pairs well with a separate system that keeps generating questions.

- **Runs entirely on your machine.** No accounts, API keys, AI/LLM calls or internet access. Question selection is plain, deterministic JavaScript.
- **No build step and no dependencies.** Plain HTML, CSS and JavaScript, served by Python's built-in web server.
- **Comes with a test manager.** Create tests, add or remove questions and reword them in the browser; changes are saved straight to the JSON files.
- **Ships with two sample exams.** A 20-question *Computing Fundamentals* bank and a 16-question *Cloud Essentials* bank in [`samples/`](samples/) work out of the box and show how several exams sit side by side.

**Try it online:** <https://carpf1sh.github.io/multiple-choice-generator/> runs the sample exams on GitHub Pages, published from `main` on every push. To use your own question banks or edit tests, run it locally.

---

## Contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Features](#features)
- [Project structure](#project-structure)
- [Configuration](#configuration)
  - [Exam registry (`exams.json`)](#exam-registry-examsjson)
  - [Manifest](#manifest)
  - [Question format](#question-format)
- [How tests are assembled](#how-tests-are-assembled)
- [Architecture](#architecture)
- [Data storage and privacy](#data-storage-and-privacy)
- [Keeping private question banks out of git](#keeping-private-question-banks-out-of-git)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| **Python** | 3.7 or newer | Used only to serve the folder locally (`python -m http.server`). No packages to install. Check with `python --version`, or `python3 --version` on macOS/Linux. |
| **Web browser** | Chrome/Edge 105+, Firefox 121+, Safari 15.4+ | Any current evergreen browser. Older browsers still work, but some controls lose their highlight styling because the stylesheet uses the CSS `:has()` selector. |
| **OS** | Windows, macOS or Linux | `start.bat` is a Windows convenience; the plain Python command works anywhere. |

Node.js, npm and other build tooling are **not** required.

### Why a local server is needed

Browsers block pages opened straight from disk (`file://…`) from reading other local files with `fetch`. The app loads its exam registry, manifests and question banks that way, so it has to be served over `http://localhost`. If you open `index.html` directly, the app shows a message telling you to start the server.

---

## Quick start

### Windows

Double-click **`start.bat`**. It:

1. Checks that Python is on your `PATH`.
2. Serves the folder at `http://localhost:47823` in the background with `pythonw` and `server.pyw`, so no console window stays open. It's bound to `127.0.0.1` so it isn't reachable from other machines. It first stops any server an earlier run left on that port.
3. Opens your default browser.

To use another port, run `start.bat 8080`. The server keeps running after you close the browser; double-click **`stop.bat`** to shut it down (or `stop.bat 8080` for another port).

### macOS / Linux (or Windows without the batch file)

From the project folder:

```bash
python3 server.pyw 47823
```

Then open <http://localhost:47823>. On Windows the command is usually `python` rather than `python3`.

`python3 -m http.server 47823 --bind 127.0.0.1` also works, but it lacks the protections in `server.pyw` (see [Architecture](#architecture)): it serves `.git/` and lists folders to any page that reaches it.

---

## Features

**Test setup**
- Question count from 1 to 200, capped at the number of questions available.
- Domain distribution:
  - *Exam weights*: the weights from the registry.
  - *Custom*: your own per-domain weights.
  - *Single domain*: drill one domain.
- A live preview of the per-domain split, with a warning when a domain doesn't have enough questions.
- Question selection: *Prefer unseen*, *Focus on missed* or *Random*.
- Question order: shuffled, or grouped by domain.
- Shuffle answer choices (on by default): rearranges each question's options every time a test starts (including retakes). The correct answer and the "why it's wrong" notes follow their option text. Avoid it for banks whose options refer to each other by letter or position (e.g. "Both A and B", "All of the above").
- Bank statistics: question and batch counts, plus each domain's share of the bank against its exam weight.

**Test modes**
- **Show answers *Immediately***: each answer locks once chosen. The correct option is highlighted, and the explanation and the reason your choice was wrong appear right away. A running score is shown.
- **Show answers *At the end***: answers can be changed freely; nothing is revealed until you submit.
- **Allow skipping *on***: skip questions and jump anywhere using the question navigator. Unanswered questions are marked incorrect when you finish (after a confirmation).
- **Allow skipping *off***: each question must be answered before moving on, and you can't jump ahead.

**Results**
- Overall score, time taken, and a per-domain breakdown shown next to each domain's exam weight.
- A full review of every question showing your answer, the correct answer, and explanations for all options. It can be filtered to *All*, *Incorrect* or *Unanswered*.
- *Retake same questions* and *Practice the missed* buttons.

**Test history**
- Every finished test is saved. Open **Test history** from the setup or results screen to see each attempt for the current exam: when it finished, how it started (new test, retake or missed practice), score and time.
- Summary stats (tests taken, average, best, average of the last 5) and a per-domain score across all your tests.
- **Review** reopens any past test in the full results view, with the same answer order it had. You can retake it or practise its missed questions from there.
- Attempts store question ids and letters only, and are rebuilt from the current bank when you open them. A question that has since been removed, or whose answer changed, still counts toward the score but is shown as unavailable and left out of retakes.
- The last 100 finished tests are kept. **Clear test history** deletes them for the current exam.

**Managing tests**

Click **Manage tests** on the setup screen (or open `/manage.html`). Changes are written to the JSON files on disk through the local server, so the online copy can only browse.

- **Create a test**: name, optional title, an id (suggested from the name), its domains and weights, and where it's stored:
  - *Private*: added to `exams.local.json`, with its files in `private/`. Both are git-ignored.
  - *Shared*: added to `exams.json`, with its files in `samples/`. Committed to git.

  The new test gets a manifest (`<id>_manifest.json`) and an empty batch (`<id>_added.json`).
- **Browse questions** for a test, filtered by domain or searched by text.
- **Add a question**: domain, subtopic, objective, question text, 2–10 options with the correct one selected, an explanation, and an optional "why it's wrong" note per option. New questions get the next free id such as `SAMPLE-D2-011` and go into `<manifest name>_added.json` next to the manifest, which is created and added to the manifest the first time.
- **Edit a question** to reword it or its answers, add or remove options, or change the correct answer. It's saved back into the batch file it came from, in the format shown under [Question format](#question-format). Alternative field names are rewritten to the standard ones, and fields the app doesn't use are kept.
- **Remove a question** from its batch file.
- Each save re-reads the batch file and manifest first, so changes made by a question generator since the page loaded aren't lost. The manifest's `item_count` and `total_questions` are kept up to date.
- A question's domain comes from `-D<n>-` in its id when it has one, so the domain of such a question can't be changed here.
- Rewording keeps a question's history. Changing its correct answer or its number of options means past tests that included it show it as changed and leave it out of retakes (see *Test history*).

**General**
- Light and dark themes. The default follows your OS setting, and the toggle in the header overrides it.
- Keyboard shortcuts:

  | Key | Action |
  |---|---|
  | `1`–`9` or `A`–`J` | Choose an option |
  | `→` | Next question (or skip, when skipping is allowed) |
  | `←` | Previous question |

- The browser warns before you close or reload the tab in the middle of a test.

---

## Project structure

```
.
├── index.html            Practice app page; applies the saved theme before first paint
├── manage.html           Test manager page
├── styles.css            All styling; light/dark themes via CSS custom properties
├── shared.js             Storage, escaping, theme, loading and validating questions (used by both pages)
├── app.js                Selection engine and UI for the practice screens
├── manage.js             Test manager: creating tests and editing questions
├── exams.json            Shared exam registry (committed)
├── exams.local.json      Optional private exam registry (git-ignored, you create it)
├── start.bat             Windows launcher; runs the local server in the background
├── stop.bat              Stops the background server
├── server.pyw            Windowless local server used by start.bat; also saves the test manager's changes
├── tests/                Node and Python tests (see Testing)
├── .github/              CI, CodeQL, Pages deployment and Dependabot configuration
└── samples/
    ├── sample_manifest.json
    ├── sample_bank_v1.json
    ├── sample_bank_v2.json
    ├── cloud_manifest.json
    ├── cloud_bank_v1.json
    └── cloud_bank_v2.json
```

There's no framework. Each page renders its screens (**Setup → Test → Results** in the app; **Tests → Questions → Editor** in the manager) by building HTML strings and escaping all question text before inserting it.

---

## Configuration

Three kinds of files work together:

```
exams.json / exams.local.json     which exams exist, their domains and weights
  └─ <exam>.manifest              which batch files make up that exam's bank
       └─ batch files             the questions themselves
```

### Exam registry (`exams.json`)

```json
{
  "exams": [
    {
      "id": "sample",
      "name": "Computing Fundamentals (Sample)",
      "title": "Computing Fundamentals Practice Test",
      "manifest": "samples/sample_manifest.json",
      "domains": [
        { "key": "D1", "name": "Networking",  "weight": 30 },
        { "key": "D2", "name": "Security",    "weight": 25 },
        { "key": "D3", "name": "Programming", "weight": 25 },
        { "key": "D4", "name": "Databases",   "weight": 20 }
      ]
    }
  ]
}
```

| Field | Required | Description |
|---|---|---|
| `id` | yes | Unique identifier. The selected exam and its custom weights are remembered by this id. |
| `name` | yes | Name shown in the exam picker. |
| `title` | no | Page and header title. Defaults to `"<name> Practice Test"`. |
| `manifest` | yes | Path to the manifest, relative to the project root. |
| `domains[].key` | yes | Domain key such as `D1`. Questions are matched to domains by this key. |
| `domains[].name` | yes | Display name. |
| `domains[].weight` | yes | Relative weight. Weights don't need to add up to 100. |

The file may be `{ "exams": [...] }` or a bare array. If **`exams.local.json`** exists, its exams are loaded too and listed first. A local exam with the same `id` as a shared one replaces it. An exam picker appears once more than one exam is registered.

### Manifest

The manifest lists the batch files in an exam's bank. Your question generator owns this file; the app only reads `batches[].file_name`.

```json
{
  "manifest_version": "1.0",
  "total_questions": 20,
  "batches": [
    { "batch_id": "v1", "file_name": "sample_bank_v1.json", "item_count": 10, "covered_subtopics": ["…"] },
    { "batch_id": "v2", "file_name": "sample_bank_v2.json", "item_count": 10, "covered_subtopics": ["…"] }
  ]
}
```

- `file_name` is resolved **relative to the manifest's folder**.
- Other fields (`item_count`, `covered_subtopics`, `target_subtopics_for_next_batches`, …) are ignored by the app, so the generator can keep whatever bookkeeping it needs there.

**Adding questions:** write a new batch file next to the manifest, append it to `batches`, then refresh the browser or click **Reload bank**. All files are fetched with `cache: no-store`, so you never see stale data.

### Question format

Each batch file is a JSON array of questions, or `{ "questions": [...] }`.

```json
{
  "id": "SAMPLE-D1-001",
  "domain": "Domain 1: Networking",
  "subtopic": "OSI Model",
  "objective": "1.1",
  "scenario_stem": "Question text…",
  "options": { "A": "…", "B": "…", "C": "…", "D": "…" },
  "correct_option": "B",
  "explanation": {
    "correct": "Why B is right…",
    "distractors": { "A": "Why A is wrong…", "C": "…", "D": "…" }
  }
}
```

| Field | Required | Accepted alternatives | Notes |
|---|---|---|---|
| `id` | recommended | none | Must be unique across all batches. History is tracked by `id`. If it's missing, one is generated from the file name and position. |
| `domain` | yes* | none | *The domain is taken from `-D<n>-` in the `id` first, then from a leading `Domain <n>` in this field. The result (`D<n>`) must match a `key` in the registry. Wording after the number doesn't matter. |
| `subtopic` | recommended | `topic` | Used to spread questions within a domain. Defaults to `General`. |
| `objective` | optional | none | An outline objective such as `"3.2"`. When present, picks are spread across objectives first, then subtopics. |
| `scenario_stem` | yes | `question`, `stem` | The question text. Line breaks are preserved. |
| `options` | yes | an array, lettered A, B, C… in order | 2–10 options. Keys must be single letters `A`–`J` and are treated case-insensitively. |
| `correct_option` | yes | `answer` | Must be one of the option letters. |
| `explanation` | optional | a plain string | `correct` is shown for the right answer; `distractors[letter]` explains why each wrong option is wrong. |

**Validation:** a question missing its stem or options, with fewer than 2 options, with an option key that isn't a single letter `A`–`J`, or whose answer isn't one of the option letters is skipped. A warning on the setup screen gives the count per file. Duplicate `id`s across batches are reported, and the **last** batch listed in the manifest wins. Questions whose domain doesn't match the registry are also reported and left out.

---

## How tests are assembled

Selection is deterministic: the same bank, settings and history always produce the same per-domain counts. Randomness is used only to break ties and to shuffle the final order.

1. **Per-domain quota.** The requested count is split across domains by weight using the [largest-remainder method](https://en.wikipedia.org/wiki/Largest_remainders_method), so the parts always add up exactly to the requested count. Ties go to the heavier domain. For example, 50 questions at weights 30/25/25/20 gives 15/13/12/10.
2. **Shortfall redistribution.** If a domain has fewer questions than its quota, all of its questions are used. The gap is shared among the remaining domains in proportion to their weights, repeating until everything is allocated. If the whole bank is smaller than the requested count, the test uses every eligible question. The setup screen previews the split and highlights short domains.
3. **Subtopic diversity.** Within each domain, questions are grouped by `objective` and then by `subtopic`, and picked **round-robin**: one from each group per round. No subtopic repeats until every subtopic in that domain has been used.
4. **History priority.** Each group is ordered by the selection mode, and in each round the groups whose next question has the highest priority go first:
   - **Prefer unseen**: fewest times seen first; ties go to whichever was seen longest ago.
   - **Focus on missed**: questions answered wrong on their most recent attempt first, ordered by error rate, then unseen questions, then the rest.
   - **Random**: history is ignored.
5. **Final order.** The picked questions are shuffled, or grouped by domain if you choose that.

History is updated once per finished test: for each question, how many times it's been seen, how many times it was wrong, whether the last attempt was wrong, and when it was last seen. Unanswered questions count as wrong.

---

## Architecture

```
init()
 ├─ loadExams()       fetch exams.json (+ exams.local.json if present), merge
 ├─ loadExam(exam)    fetch manifest → fetch all batches in parallel (Promise.allSettled)
 │    └─ normalize()  validate each question and map it to the internal shape and domain key
 └─ renderSetup()
       └─ generateTest()  planTest() → allocate() → pickFromDomain() per domain → shuffle
             └─ startTest() → renderTest() ⇄ choose()/goTo()/next() → finishTest()
                   └─ update history → renderResults()
```

| Piece | Where (`app.js`) | Role |
|---|---|---|
| `largestRemainder`, `allocate` | Selection engine | Per-domain quotas and shortfall redistribution |
| `priorityScore`, `orderByPriority` | Selection engine | Ranks questions using local history |
| `interleave`, `pickFromDomain` | Selection engine | Round-robin across objectives and subtopics |
| `renderSetup`, `renderTest`, `renderResults` | Screens | Render each screen and bind its events |
| `store` | Storage (`shared.js`) | `localStorage` wrapper that never throws, so the app still works when storage is blocked |
| `toRawQuestion`, `upsertQuestion`, `removeQuestion`, `updateManifestCounts`, `newExamFiles` | `manage.js` | Turn the editor's changes into updated batch, manifest and registry files |

**State:** one in-memory `state` object holds the loaded exams, the normalised questions, settings, history and the current test. Settings and history are kept in sync with `localStorage`; a test in progress is not saved.

**Saving:** `server.pyw` has two endpoints for the test manager. `GET /api/status` tells the manager it can save; on GitHub Pages or `python -m http.server` it's missing, and the manager is read-only. `POST /api/files` takes `{"files": [{"path": "...", "data": ...}]}` and writes each file as formatted JSON (via a temporary file, so a file is never half-written). It checks every path before writing any.

**Security:** all text that comes from question files is HTML-escaped before rendering, and option keys must be single letters. The server is bound to `127.0.0.1`. Because a web page can still reach it through DNS rebinding, `server.pyw` also refuses requests whose `Host` isn't `localhost` or `127.0.0.1`, never serves dotfiles such as `.git/`, and doesn't list folders. Saving additionally requires:

- an `Origin` of `http://localhost:<port>` or `http://127.0.0.1:<port>`, so other websites can't post to it;
- `Content-Type: application/json` and a body of at most 5 MB;
- paths that are relative `.json` files with no `..` or dot-segments, and that are `exams.json`, `exams.local.json`, or inside `samples/`, `private/` or the folder of a registered manifest. Nothing else in the project, such as the app's own code, can be overwritten. Names Windows would refuse or quietly change (`CON`, `NUL`, trailing spaces or dots, `<>:"|?*`) are refused too, and each file may be listed only once;
- valid JSON without `NaN` or `Infinity`, which browsers can't read;
- for `exams.json` and `exams.local.json`, a registry the app can load: unique exam ids, a name, a relative `.json` manifest path, and domains with unique `D<n>` keys, names and weights above 0.

The test manager checks its forms before saving: names, ids and texts have length limits, domain names and answer options must be distinct, weights must be numbers above 0 and at most 1000, and a question's domain must belong to its test.

The app makes no requests outside the local server.

---

## Data storage and privacy

Everything stays in your browser's `localStorage`, scoped to the server's origin (`http://localhost:<port>`):

| Key | Contents |
|---|---|
| `mcq.settings` | Last-used setup options, the selected exam, and custom weights for each exam |
| `mcq.history` | Per-question `seen`, `wrong`, `lastWrong`, `last` (timestamp) |
| `mcq.attempts` | Test history: the last 100 finished tests, each with its exam, timings, options and per-question id, domain, chosen and correct letter (and option order when shuffled) |
| `mcq.theme` | `light` or `dark` |

- **Reset history** on the setup screen clears `mcq.history`; your test history is kept.
- **Clear test history** on the Test history screen removes the current exam's entries from `mcq.attempts`.
- Because storage is per origin, using a different port (for example, `start.bat 8080`) starts with empty settings and history.
- Clearing your browser's site data for `localhost` resets everything.
- The [online version](https://carpf1sh.github.io/multiple-choice-generator/) keeps its own separate settings and history, stored under `carpf1sh.github.io`.

---

## Keeping private question banks out of git

For licensed or proprietary material you don't want in the repository:

1. Put the manifest and batch files in a `private/` folder. It's git-ignored.
2. Register the exam in `exams.local.json` in the project root (also git-ignored), using the same format as `exams.json`.

The app loads both registries, so private and shared exams appear together locally, while only the shared ones are committed.

If your files have to live somewhere else (for example, because a generator writes to fixed paths), add their names to `.git/info/exclude`. It works like `.gitignore` but is never committed, so even the file names stay private.

---

## Testing

The tests use only the built-in runners, so there is still nothing to install beyond Node.js (22 or newer) and Python. Node is needed only to run the tests, not the app.

```bash
node --test
python -m unittest discover -s tests
```

| File | Covers |
|---|---|
| `tests/app.test.js` | Question validation and escaping, the largest-remainder split and shortfall redistribution, history priority, subtopic round-robin, answer shuffling, and saving and restoring test history. `tests/load-app.js` loads `shared.js` and `app.js` (or `manage.js`) unchanged into a minimal fake browser. |
| `tests/manage.test.js` | The test manager's file changes: questions built from the editor pass validation and keep unknown fields, batch files keep their shape, ids continue the numbering, manifest counts stay right, and new tests produce valid registry, manifest and batch files. |
| `tests/repo.test.js` | Every exam in `exams.json` and every question in its bank is valid, has a unique id and a known domain. The app references no external hosts. |
| `tests/test_server.py` | `server.pyw` refuses foreign `Host` headers, never serves dotfiles (including encoded paths), doesn't list folders, and stays inside its folder. Saving works in the allowed places and is refused for foreign hosts or origins, wrong content types, oversized bodies, traversal, dotfiles, non-JSON files and other folders, without writing anything. |

**Automation** (GitHub Actions, in `.github/`):

- **CI** runs both test suites on Ubuntu and Windows for every push to `main` and every pull request, and fails if anything in `private/` or `exams.local.json` is committed.
- **CodeQL** scans the JavaScript, Python and workflow files with the `security-extended` queries on every push and pull request, and weekly.
- **Dependabot** keeps the workflow actions up to date. They're pinned to commit SHAs so a moved tag can't change what runs.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Start the local server" message | You opened `index.html` from disk. Run `start.bat` or the Python command and go to `http://localhost:47823`. |
| `Python was not found on PATH` | Install Python 3 from [python.org](https://www.python.org/downloads/) and tick **Add python.exe to PATH**, or run the command with the full path to `python.exe`. |
| Browser can't connect, or "Failed to fetch" | Another program may be using port 47823. Run `start.bat 8080` (or another port). If you run the Python command yourself, this shows as `OSError: [Errno 98/10048] Address already in use`. |
| New batch doesn't appear | Make sure it's listed under `batches` in the manifest and that `file_name` is relative to the manifest's folder, then click **Reload bank**. |
| "Heads up" warnings on the setup screen | A batch failed to load (missing file or invalid JSON), or questions were skipped, duplicated or had an unknown domain. The message names the file. |
| A domain shows as short | The bank has fewer questions in that domain than its weight calls for. The app fills the gap from other domains; add more questions for that domain to fix it. |
| The test manager says editing needs the local server | You're on the online copy or started the server with `python -m http.server`. Run `start.bat` or `python server.pyw` and open `http://localhost:47823/manage.html`. |
| Settings or history seem lost | You're probably on a different port or browser profile, or site data was cleared. See [Data storage](#data-storage-and-privacy). |

---

## License

Copyright 2026 Brandon Carp. Licensed under the [Apache License, Version 2.0](LICENSE); see [NOTICE](NOTICE).

This covers the app code and the sample question banks in `samples/`. Question banks you add yourself, including any in `private/` or registered in `exams.local.json`, are not part of this repository and aren't covered by its license.
