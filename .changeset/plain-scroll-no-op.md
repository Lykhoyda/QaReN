---
"qaren": patch
---

Plain scrolls that leave the screen unchanged after two clean attempts now pass with the typed reason `SCROLL_NO_VISIBLE_CHANGE`, while dispatch errors, uncertain effects, context changes, and missing scroll-until targets still fail with diagnostic causes and existing guidance.
