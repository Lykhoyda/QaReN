---
"qaren": patch
---

Android QA can now accept or dismiss a system dialog, such as the notification permission prompt: the runner taps exactly one labelled button in the dialog above the app, including a prompt that takes the app's place on screen, and the step passes only when that dialog is gone and the app is back in front. `Don't allow` is now a dismiss label. While a system dialog is in front, QA sends no scroll or back to the app, ends a step that would tap the dialog's own button with `OUTSIDE_APP_WINDOW`, and leaves a prompt to the plan's next dialog step when there is one.
