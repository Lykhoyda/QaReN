---
'qaren': patch
---

Refuse a dev-client attach with no target whose app exited or never requested a bundle after the configurable `deadlines.attach_seconds`, retain attach-state diagnostics, and re-prove transient runner-host cleanup failures before retaining the device lease.
