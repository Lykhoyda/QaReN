---
"qaren": patch
---

A quoted fill whose testID matches both a native input and a React-only input is refused as ambiguous again before any tap, while a sole React-only match still routes to the keyboard fallback.
