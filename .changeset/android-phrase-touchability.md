---
"qaren": minor
---

Android phrase steps now resolve on screens whose only covers are transparent, non-interactive chrome, such as the dev client's overlay, React Native's debugging overlay or a parked bottom sheet. A control counts as observed only when both the Android runner and React Native's own hit test agree that a touch at its centre reaches it. A control whose touch a React overlay takes keeps its identity but cannot be pressed or filled in that capture, so a phrase step naming it refuses while the rest of the screen stays usable. The Android runner must be rebuilt for this release; an earlier runner is refused as stale. iOS, literal plans and controls under the keyboard are unchanged.
