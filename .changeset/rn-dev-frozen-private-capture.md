---
"qaren": patch
---

Admit private screen capture on React Native dev builds, whose renderer deep-freezes host props into identity accessors and whose Fragment fibers carry child arrays, instead of refusing every screen with `PRIVATE_INPUT_CAPTURE_UNKNOWN`.
