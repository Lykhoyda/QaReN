---
"qaren": patch
---

On iOS, a quoted Tap on a text that exists only inside a view the app hides from accessibility now taps that text's button once when the same read proves the button by its own unique test id; otherwise the Tap, a Wait or a literal check fails with the cause: the text, the button that holds it (its frame and test id) and the fix, instead of a bare "not found".
