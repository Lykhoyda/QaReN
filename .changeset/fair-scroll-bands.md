---
"qaren": patch
---

Drag plain scrolls inside reachable scroll views, detect frame movement, and report covered containers or unchanged content with typed diagnostics. A cover refuses only when its React host is proven to take touches; pointer-transparent covers let the drag through, unproven covers are dragged across and judged by the result, and hidden containers are never chosen.
