---
'qaren': patch
---

Recognize iOS RedBox and LogBox and Android native RedBox overlays during walks, record bounded attempts to dismiss them with their own control, and refuse `DEV_REDBOX` when safe progress cannot be proven without exposing error text.
