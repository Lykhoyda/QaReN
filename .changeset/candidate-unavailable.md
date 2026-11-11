---
"qaren": patch
---

Report a candidate that cannot be read mid-run (missing repository or project root, failed or timed-out Git read, unreadable integration or lockfile read) as the refusal `CANDIDATE_UNAVAILABLE` (exit 4) instead of `CANDIDATE_DRIFTED`, at every verification site; after the walk the refusal keeps the ledger rows, keeps its own phase and next step, and persists the final verification's classification.
