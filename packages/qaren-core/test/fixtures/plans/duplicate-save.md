# Duplicate Save quoted-target ambiguity on the workspace test-app

Runs from a fresh install of the dedicated workspace test-app, starting at onboarding and entering through the normal Home QA acceptance control. No deep link, navigation dispatch, or state shortcut is part of this plan.

The fixture renders two simultaneously visible, enabled, accessible native buttons labelled `Save`. The lower button, `qa-choice-b`, displays `Choice B saved`; the upper `qa-choice-a` displays `Choice A saved`. Their neutral IDs do not describe position. The screen initially shows neither result.

Step 8 expects `TARGET_AMBIGUOUS` under the [plan resolution contract](../../../../qaren-cli/README.md#check-a-plan); the following result check is not reached. Unit tests establish rendering and independent outcomes, not live device acceptance.

## QA

### Choose the lower Save through the normal entry route

1. Tap "onboarding-skip"
2. Tap "onboarding-done"
3. Wait for "Welcome" to appear
4. Tap "home-qa-acceptance-btn"
5. Wait for "qa-acceptance-start-screen" to appear
6. Tap "qa-acceptance-duplicate-save"
7. Wait for "qa-duplicate-save-screen" to appear
✓ "No selection yet"
8. Tap "Save" at the bottom
✓ "Choice B saved"
