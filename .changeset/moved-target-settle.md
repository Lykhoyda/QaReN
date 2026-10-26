---
"qaren": patch
---

A tap or fill refused because its target moved now records the retained and live frames, and the one retry waits until the same target holds one frame across two captures before dispatching again, failing with the observed frames if it never settles.
