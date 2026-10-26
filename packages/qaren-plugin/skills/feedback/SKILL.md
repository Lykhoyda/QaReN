---
name: feedback
description: Use when the user wants to report a QaReN bug or request a feature. Drafts a sanitized GitHub issue and files it only after the user confirms.
---

# Report a QaReN issue

Draft the issue locally, show it in full, and file it only after the user says yes.

## 1. Gather the environment

Run each command and keep its first line of output:

```sh
qaren --version
sw_vers -productVersion
xcodebuild -version | head -1
node --version
```

If a command is missing or fails, record that instead of guessing a value.

## 2. Add the run, when the report is about one

Take these fields from that run's receipt (the JSON `qaren check` or `qaren pr` printed):

- `result`
- `run_id`
- `failure.code`
- `failure.next_action`

Include `~/.qaren/runs/<run-id>/report.md`. It is value-free by design: plan lines come
from the walk's privacy-projected rows, not the raw plan file. If it shows a value the
user typed, stop and report that as a privacy bug rather than filing the draft.

Never include, unless the user explicitly asks for it:

- anything under the run's `media/` or `screenshots/` directories;
- plan text containing typed values;
- values from `.qaren/config.yaml`.

## 3. Show the draft

Write the title and body to a temporary file, then show the whole file to the user. The body
holds a short summary, the steps to reproduce, the expected and actual behaviour, the
environment from step 1 and the run fields from step 2.

## 4. File it after an explicit yes

Only after the user confirms the exact draft:

```sh
gh issue create --repo Lykhoyda/rn-dev-agent --title "<title>" --body-file <file>
```

If the user asks for changes, update the file and show it again before filing.

## 5. Report the issue URL

Print the URL `gh` returns. If `gh` is not authenticated, say so and leave the draft file
for the user to submit.
