# Practice Test App

A local, browser-based multiple-choice practice test generator. Tests of 1–200 questions are drawn from JSON question banks, weighted to match the real exam's domain distribution and spread across subtopics.

Everything runs locally. There are no AI/LLM calls, API keys, accounts or network access, and no dependencies beyond Python's built-in web server.

## Running it

Double-click `start.bat` (or run `start.bat 8080` to use another port). It serves this folder at `http://localhost:8000` and opens your browser.

Without the batch file:

```bash
python -m http.server 8000 --bind 127.0.0.1
```

then open http://localhost:8000. Opening `index.html` directly from disk doesn't work, because browsers block `file://` pages from reading other local files.

## How question banks are found

```
exams.json                         ← registry of exams + domain weights (shared)
exams.local.json                   ← optional private registry (git-ignored)
  └─ samples/sample_manifest.json  ← list of batches (maintained by your generator)
       ├─ sample_bank_v1.json
       ├─ sample_bank_v2.json
       └─ ...
```

The repo ships with a small **Computing Fundamentals** sample exam (20 questions) in `samples/` so the app works out of the box.

On every page load the app reads `exams.json` and, if it exists, `exams.local.json`. It then reads each exam's manifest and **every file in `batches[].file_name`**. To add questions, the generator only needs to:

1. Write the new batch file next to the manifest (paths are relative to the manifest).
2. Append an entry to `batches` in the manifest.

Then refresh the browser, or click **Reload bank** on the setup screen. If a batch file is missing or malformed, the app shows a warning and keeps going with the rest. If the same question `id` appears in more than one batch, the copy from the later batch wins.

### Adding another exam

Add an entry to `exams.json`. For content you don't want committed, such as licensed or proprietary exam material, use `exams.local.json` instead:

```json
{
  "exams": [
    {
      "id": "my-exam",
      "name": "My Exam",
      "manifest": "private/my_exam_manifest.json",
      "domains": [
        { "key": "D1", "name": "First Domain", "weight": 40 },
        { "key": "D2", "name": "Second Domain", "weight": 60 }
      ]
    }
  ]
}
```

Weights are relative, so they don't have to add up to 100. An exam picker appears once more than one exam is registered, and exams from `exams.local.json` are listed first.

### Keeping private banks out of git

`.gitignore` excludes `exams.local.json` and the `private/` folder. Keep private manifests and batch files in `private/` (or add their names to `.gitignore`) and register them in `exams.local.json`.

## Question format

```json
{
  "id": "SAMPLE-D1-001",
  "domain": "Domain 1: Networking",
  "subtopic": "OSI Model",
  "objective": "1.1",
  "scenario_stem": "Question text…",
  "options": { "A": "…", "B": "…", "C": "…", "D": "…" },
  "correct_option": "A",
  "explanation": {
    "correct": "Why A is right…",
    "distractors": { "B": "Why B is wrong…", "C": "…", "D": "…" }
  }
}
```

- **Domain**: taken from `-D<n>-` in the `id`, otherwise from the leading `Domain <n>` in `domain`. It must match a `key` in `exams.json` (`D1`, `D2`, …). Wording differences after the number don't matter.
- **`objective`** *(optional, recommended)*: the outline objective (for example `"3.2"`). When it's present, picks are spread across objectives first, then subtopics.
- **Accepted alternatives**: `question` or `stem` instead of `scenario_stem`; `answer` instead of `correct_option`; `options` as an array (lettered A, B, C… in order); `explanation` as a plain string. A batch file may be a top-level array or `{ "questions": [...] }`.

## How a test is assembled (deterministic)

1. **Per-domain quota**: the requested count is split by the domain weights using the largest-remainder method, so the parts always add up exactly to the count.
2. **Shortfall**: if a domain doesn't have enough questions, all of them are used and the gap is redistributed to the other domains in proportion to their weights. The setup screen previews this.
3. **Diversity**: within a domain, questions are picked round-robin across objectives and subtopics, so nothing repeats until every subtopic has been used.
4. **Priority**: inside each group, questions are ordered by your local history:
   - *Prefer unseen*: questions you've seen the fewest times come first, then those you saw longest ago.
   - *Focus on missed*: questions you got wrong last time come first.
   - *Random*: history is ignored.

History and settings are stored in the browser's `localStorage`. **Reset history** on the setup screen clears the history.
