---
'qaren': patch
---

A tap or fill after an explicit `Scroll` step now waits for the scrolled frame to settle before dispatching, instead of targeting a field still moving from the scroll's momentum.
