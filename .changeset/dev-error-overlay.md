---
'qaren': patch
---

Recognize iOS RedBox and LogBox development error overlays only, dismiss them with their own Dismiss control up to three times per step with each attempt recorded, and refuse `DEV_REDBOX` for covered or uncertain steps without exposing error text; Android's native RedBox (`rn_redbox_stack` / `rn_redbox_dismiss_button`) is a tracked follow-up.
