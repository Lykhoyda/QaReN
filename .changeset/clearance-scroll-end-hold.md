---
'qaren': patch
---

On iOS, a scroll that moves a target clear by a set distance now holds still before lifting, so the list stops where the drag ends instead of gliding on. It needs a runner that lists `DRAG_END_HOLD_V1`; with an older runner the scroll behaves as before and the run log says `endHold=unsupported`.
