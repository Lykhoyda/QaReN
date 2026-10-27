# Tap comparison fixtures

Control crops from an iOS simulator at point scale 3. Runner screenshots are
8-bit RGB; raw simulator frames are 8-bit RGBA. All are non-interlaced.

- `toggle1-before/after`: a checkmark visibly changes (about 36% of pixels).
- `chip-before/after`: an already-selected chip stays identical.
- `moved-before/after`: a neighbouring row moves; about 7% of pixels differ,
  so matching target frames must be checked separately.
- `spinner-a/b`: a busy indicator changes between frames.
- `transition-mid/settled`: a navigation header changes while settling.

Only the control crops are included, without full-screen source images.
