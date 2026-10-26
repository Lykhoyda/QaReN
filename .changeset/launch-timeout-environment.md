---
"qaren": patch
---

A dev-client launch that times out under host load is retried once and otherwise refused as an environment condition with the host-load reading, instead of being reported as a build failure.
