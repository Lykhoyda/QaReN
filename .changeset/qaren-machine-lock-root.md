---
"qaren": patch
---

Store device and host locks machine-wide by default, so any home on the machine sees an existing lease and refuses it; QAREN_MACHINE_LOCKS=0 keeps per-home locks.
