---
"qaren": patch
---

Re-read private native snapshots whose only incomplete cause is dropped nodes within the existing capture retry window. Wait polls and presence captures keep their current behavior. Persistent dropped snapshots retain their cause with a retry-deadline marker, and each dropped-snapshot re-read emits a value-free native-reread diagnostic.
