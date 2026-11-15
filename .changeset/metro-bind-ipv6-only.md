---
"qaren": patch
---

Refuse an iOS Metro that answers on `[::1]` only with `METRO_BIND_IPV6_ONLY` within seconds instead of at the build deadline, record the bound address as `metro_bind`, and add a `metro-bind` doctor row.
