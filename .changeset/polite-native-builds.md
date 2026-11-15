---
"qaren": patch
---

Run every native build at lower CPU priority (`nice -n 10`) and cap the workers of builds whose command line QaReN controls from the machine's cores and memory: Gradle workers on both Android paths and `-jobs` on the workspace `xcodebuild` line, with no Gradle daemon left by `expo run:android`. `build.jobs` and `build.priority: normal` in `.qaren/config.yaml` override the defaults, a worker setting in the user's own `GRADLE_OPTS` wins, and the receipt records what each build got. The default `expo run:ios` build is not capped.
