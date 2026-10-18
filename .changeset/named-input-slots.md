---
"qaren": minor
---

Add named runtime input slots: `Fill "field" with input NAME` types `QAREN_INPUT_NAME` without storing, logging or hashing it, lets a plan declare `Expect input NAME on screen` where the app shows a value, saves login blocks by input name, and refuses `PLAN_INPUT_MISSING` before device selection when a value is missing.
