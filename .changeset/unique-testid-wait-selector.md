---
"qaren": patch
---

A saved wait stores a testID only when no other on-screen element shares it, so a uniquely labelled control with a shared testID replays by its text instead of re-walking.
