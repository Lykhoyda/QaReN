---
"qaren": patch
---

Recover once from an iOS Metro that answers on `[::1]` only: QaReN stops its Metro and starts it again on all network interfaces, with the advertised host pinned to `127.0.0.1`, within the same build deadline. The receipt (`metro_bind: 127.0.0.1 after restart on all interfaces`) and the report say so. A second `[::1]`-only finding, or a first Metro that cannot be stopped, still refuses `METRO_BIND_IPV6_ONLY`, and the detail now names what was tried.
