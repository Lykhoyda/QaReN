---
"qaren": minor
---

On Android, an explicit `Wait for "<testID>"` (or `… to appear`, `Wait until "<testID>" appears`) now passes on a text input hidden in place, such as a code field's transparent input behind its digit boxes, on the terms a visible testID passes, when it is a native text input, enabled, on a complete capture with the app in front, with its centre inside its known visible area. The ledger row says it passed on presence of a native input carrying the testID, not on visibility, and does not say which React input it is. When such a Wait ends in a definite stable absence and the last observed screen shows the input hidden in place with its own `absent` diagnosis, the suggestion names what that screen lacks, or that the Wait did not establish the input's presence, with the next step. When recovery has a plan edit for an interruption, the failure keeps that edit. Fill, Tap, scroll-until, block starts and iOS are unchanged.
