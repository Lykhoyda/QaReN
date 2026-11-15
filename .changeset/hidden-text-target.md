---
"qaren": patch
---

On iOS, a quoted Tap, Wait or literal check whose text exists only inside a view the app hides from accessibility now fails with the cause: the text, the button that holds it (its frame and test id) and the fix, instead of a bare "not found".
