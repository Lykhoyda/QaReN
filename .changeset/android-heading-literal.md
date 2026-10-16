---
"qaren": patch
---

On Android, visible header-role text (for example `<Text accessibilityRole="header">`) now satisfies a literal check. When a literal check fails while a node carrying that text exists, the failure says why it was not counted: `not-visible` (reported not visible or outside the viewport) or `not-literal-kind` (not literal text). The added explanation repeats only the plan's own literal.
