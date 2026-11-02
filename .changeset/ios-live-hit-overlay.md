---
"qaren": patch
---

Fix iOS presses falsely blocked by inferred overlays by requiring a proven live hit and native element activation after the clearance scroll, including when that scroll is refused because the band is too small, refusing without a tap when either is unavailable, and identifying inferred band cutters without labels, identifiers or values. Overlay refusals that keep the inferred rule say why no live hit read was asked.
