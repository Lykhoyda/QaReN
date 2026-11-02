---
'qaren': patch
---

Recognize iOS RedBox and LogBox and Android native RedBox development error overlays, dismiss them with their own Dismiss control up to three times per step with each attempt recorded, and refuse `DEV_REDBOX` for covered or uncertain steps without exposing error text, with Android native RedBox covered by automated tests only and no Android device proof, and Android LogBox out of scope.
