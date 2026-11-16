---
"qaren": patch
---

On iOS, a quoted Tap on a text hidden from accessibility now presses its button once even when the button has neither label nor test id, if a full read taken just before the press ties the text to exactly one native button by its frame; such a step stores no selector, so its block is reported not saved.
