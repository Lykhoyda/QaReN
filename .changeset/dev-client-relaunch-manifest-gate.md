---
'qaren': patch
---

Relaunch an iOS dev client again only when its launcher gave up on a manifest Metro answered too late, never killing a launch whose manifest was answered inside the dev client's 10-second request timeout, and relaunch only once Metro answers in time, within the CLI launch's 60-second bound.
