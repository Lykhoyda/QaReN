---
"qaren": patch
---

On Android, when a Wait ends in a definite stable absence and the failure's last observed screen shows the one element carrying its testID hidden in place (Android reports it as not visible to the user although its frame overlaps the visible area with its centre inside, such as a code field's transparent input behind its digit boxes), and that screen's own diagnosis is that the target is absent, the failure now says so. For a native input the suggestion gives examples of visible testIDs to wait for and suggests a Tap if the app provides a control that focuses the input; for another element it suggests waiting for a visible control. A failing saved login block passes that suggestion to the step it interrupted. The failure code and subreason are unchanged, and a Wait still does not count such an element present.
