---
"qaren": patch
---

Give Android walks the same visibility, keyboard, occlusion and foreign-driver answers as iOS: QA reads on Android take one live traversal of the accessibility windows with roots, ancestry, a keyboard node and a snapshot generation, a tap whose only visible effect is opening the keyboard counts as a screen change, and the runner's exact tap on an editable field returns once that keyboard is shown, within the tap's post-act settle budget, with a failed step naming a keyboard that did not open, a front dialog of another app reads as a dialog, a control not visible to the user counts as off screen unless the keyboard covers it, which reads as keyboard-covered as on iOS and gets one clearance scroll sized to clear the keyboard, the runner refuses a covered tap or focus tap as `FOCUS_TARGET_OCCLUDED` so the walker scrolls once and retries, and admission refuses when another automation driver holds the emulator.
