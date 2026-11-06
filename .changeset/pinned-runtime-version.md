---
"qaren": patch
---

Serve the runtime version the installed iOS app embeds to QaReN's own dev server, so apps using the expo-updates `fingerprint` runtimeVersion policy no longer recompute the project fingerprint on every manifest request; the receipt records the embedded policy and pin state, and a manifest warm-up refusal names that policy when the pin was not served.
