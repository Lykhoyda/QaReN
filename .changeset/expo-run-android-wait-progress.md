---
"qaren": patch
---

`qaren prepare` on Android no longer gives up on `expo run:android` at `deadlines.build_seconds` alone: past the limit the wait goes on while it observes the output count increasing. The window is three times the limit, capped at 7200 s; a turn admitted by the end of the window finishes, so the return can come later. A cut says whether the wait stopped observing count increases for the idle window or reached the end of its admission window.
