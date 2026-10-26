---
"qaren": patch
---

During launch, the dev-build check and helper injection wait for the app's answer until the existing attach deadline instead of a fixed 5 s, so a slow but live app attaches, and an expired wait is classified as a readiness timeout.
