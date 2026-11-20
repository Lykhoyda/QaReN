---
"qaren": patch
---

A plan step that fails in a `qaren check --installed-app` run now says what the mode changes. Its next step keeps the step's own guidance, then explains that QaReN read only the native screen: a target needs a testID or an exact visible label, a control known only to React is not found, a name shared by a wrapper and its inner control is ambiguous, and an unplanned app screen or login wall is not handled. It ends by suggesting to quote the control's own testID or to run without `--installed-app`. The failure's next step carries it; for a run that is not held, so does the receipt's next step, after any cleanup command the teardown still needs. The run's `report.md` names the tested build under its header: "Tested the installed app (version …, build …): no React evidence, no model, strict media rules, no recording." Default runs are unchanged.
