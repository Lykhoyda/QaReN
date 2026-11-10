---
"qaren": patch
---

Prove the iOS simulator is still in the run's custody and Booted before every install attempt: re-boot a Shutdown target under the run's custody when the run may boot it and enough budget remains, otherwise refuse with `DEVICE_NOT_BOOTED` (exit 4), naming when the simulator was last seen Booted and when it was found Shutdown, and how to recover.
