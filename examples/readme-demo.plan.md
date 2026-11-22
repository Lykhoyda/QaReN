# Onboarding and task completion

Start on the first onboarding page with the sample tasks in their initial state.
The two active tasks are "Review pull request" and "Update documentation".
The flow opens the Tasks tab directly from Home without signing in.

## Recording

From `test-app` on the demo branch, set `DEMO_PR_URL` to the demo pull request URL and run:

```sh
EXPO_PUBLIC_QA_RECORDING=1 qaren pr "$DEMO_PR_URL" --fresh-install --plan-file .qaren/plans/readme-demo.md
```

The flag must be present when QaReN starts Metro for the demo candidate.

## QA

1. Tap "Next"
✓ "Understand your codebase deeply, then build with confidence"
2. Tap "Next"
✓ "Verify"
3. Tap "Get Started"
4. Wait for "home-welcome" to appear
✓ "Your sample tasks at a glance"
5. Tap "tab-tasks"
6. Wait for "Tasks (2 active)" to appear
✓ "Tasks (2 active)"
7. Tap "task-toggle-1"
8. Wait for "Tasks (1 active)" to appear
✓ "Tasks (1 active)"
