# Practice Test App

A local, browser-based multiple-choice practice test generator. It builds tests of 1–200 questions from JSON question banks, weighted to match an exam's domain distribution and spread across subtopics. It picks up new question batches automatically as they're added to a manifest, so it pairs well with a separate system that keeps generating questions.

- **Runs entirely on your machine.** No accounts, API keys, AI/LLM calls or internet access. Question selection is plain, deterministic JavaScript.
- **No build step and no dependencies.** Plain HTML, CSS and JavaScript, served by Python's built-in web server.
- **Ships with a sample exam.** A 20-question *Computing Fundamentals* bank in [`samples/`](samples/) works out of the box.

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
- [Troubleshooting](#troubleshooting)

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
2. Serves the folder at `http://localhost:8000`, bound to `127.0.0.1` so it isn't reachable from other machines.
3. Opens your default browser.

To use another port, run `start.bat 8080`. Stop the server with **Ctrl+C** in its window, or by closing the window.

### macOS / Linux (or Windows without the batch file)

From the project folder:

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

Then open <http://localhost:8000>. On Windows the command is usually `python` rather than `python3`.

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
├── index.html            Page shell; applies the saved theme before first paint
├── styles.css            All styling; light/dark themes via CSS custom properties
├── app.js                Loading, validation, selection engine, UI for all three screens
├── exams.json            Shared exam registry (committed)
├── exams.local.json      Optional private exam registry (git-ignored, you create it)
├── start.bat             Windows launcher for the local server
└── samples/
    ├── sample_manifest.json
    ├── sample_bank_v1.json
    └── sample_bank_v2.json
```

The app is a single script with no framework. It renders each screen (**Setup → Test → Results**) by building HTML strings and escaping all question text before inserting it.

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
| `options` | yes | an array, lettered A, B, C… in order | 2–10 options. Keys are treated case-insensitively. |
| `correct_option` | yes | `answer` | Must be one of the option letters. |
| `explanation` | optional | a plain string | `correct` is shown for the right answer; `distractors[letter]` explains why each wrong option is wrong. |

**Validation:** a question missing its stem or options, with fewer than 2 options, or whose answer isn't one of the option letters is skipped. A warning on the setup screen gives the count per file. Duplicate `id`s across batches are reported, and the **last** batch listed in the manifest wins. Questions whose domain doesn't match the registry are also reported and left out.

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
| `store` | Storage | `localStorage` wrapper that never throws, so the app still works when storage is blocked |

**State:** one in-memory `state` object holds the loaded exams, the normalised questions, settings, history and the current test. Settings and history are kept in sync with `localStorage`; a test in progress is not saved.

**Security:** all text that comes from question files is HTML-escaped before rendering. The server is bound to `127.0.0.1`, and the app makes no requests outside the local server.

---

## Data storage and privacy

Everything stays in your browser's `localStorage`, scoped to the server's origin (`http://localhost:<port>`):

| Key | Contents |
|---|---|
| `mcq.settings` | Last-used setup options, the selected exam, and custom weights for each exam |
| `mcq.history` | Per-question `seen`, `wrong`, `lastWrong`, `last` (timestamp) |
| `mcq.theme` | `light` or `dark` |

- **Reset history** on the setup screen clears `mcq.history`.
- Because storage is per origin, using a different port (for example, `start.bat 8080`) starts with empty settings and history.
- Clearing your browser's site data for `localhost` resets everything.

---

## Keeping private question banks out of git

For licensed or proprietary material you don't want in the repository:

1. Put the manifest and batch files in a `private/` folder. It's git-ignored.
2. Register the exam in `exams.local.json` in the project root (also git-ignored), using the same format as `exams.json`.

The app loads both registries, so private and shared exams appear together locally, while only the shared ones are committed.

If your files have to live somewhere else (for example, because a generator writes to fixed paths), add their names to `.git/info/exclude`. It works like `.gitignore` but is never committed, so even the file names stay private.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Start the local server" message | You opened `index.html` from disk. Run `start.bat` or the Python command and go to `http://localhost:8000`. |
| `Python was not found on PATH` | Install Python 3 from [python.org](https://www.python.org/downloads/) and tick **Add python.exe to PATH**, or run the command with the full path to `python.exe`. |
| `OSError: [Errno 98/10048] Address already in use` | Another program is using port 8000. Run `start.bat 8080` (or another port). |
| New batch doesn't appear | Make sure it's listed under `batches` in the manifest and that `file_name` is relative to the manifest's folder, then click **Reload bank**. |
| "Heads up" warnings on the setup screen | A batch failed to load (missing file or invalid JSON), or questions were skipped, duplicated or had an unknown domain. The message names the file. |
| A domain shows as short | The bank has fewer questions in that domain than its weight calls for. The app fills the gap from other domains; add more questions for that domain to fix it. |
| Settings or history seem lost | You're probably on a different port or browser profile, or site data was cleared. See [Data storage](#data-storage-and-privacy). |
