---
'qaren': patch
---

On iOS, a tap aimed into an open app alert now presses that alert's own button instead of letting XCTest press its cancel button first, other gestures behind the alert fail as `APP_ALERT_INTERRUPTION` without pressing anything, and workspace simulator builds are ad-hoc signed so apps that read the keychain launch cleanly.
