---
"qaren": patch
---

Reclaim a device lease held by a dead run through that run's own cleanup, and end a run with `RUN_CANCELLED` after normal teardown when it is signalled or its caller exits.
