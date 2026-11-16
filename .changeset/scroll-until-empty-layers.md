---
qaren: patch
---

On iOS, `Scroll down until "<target>"` no longer refuses with `SCROLL_BAND_TOO_SMALL` because of a full-screen layer with nothing of its own over the list, such as a closed bottom sheet or an empty toolbar node, while controls, dim layers, open sheets and views that take touches still block it.
