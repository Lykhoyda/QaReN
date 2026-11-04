QaReN is a QA engineer for your coding agent. It tests each React Native change on a simulator and tells you PASS or FAIL, with video proof.

The direction is **Verdict Log: a calm terminal at night**. Dark grounds, quiet monospaced labels, one amber cursor, and a verdict that is always the loudest thing on the screen. Readers are React Native developers who use coding agents and meet QaReN on X, on GitHub, in pull request comments and in the docs, mostly on dark screens. The personality is calm, careful and precise.

## The three rules

1. **The verdict is the loudest element.** On any screen that shows a result, the `VerdictPill` is the most saturated and heaviest thing. Nothing else uses `pass` or `fail` at a larger size.
2. **The verdict is always a word.** Write PASS or FAIL, with a check or cross glyph beside it. Never show a result by colour alone: no green dots, red borders or coloured rows without the word.
3. **One accent per screen.** `accent` (amber) appears on at most one UI element per screen: a primary button, *or* a running step, *or* a caution callout, *or* the wordmark's cursor block. Pick one. The amber cursor inside the logo is part of the mark and does not count.

## Voice and copy

- Sentence case everywhere: headings, buttons, labels, badges. PASS and FAIL are the only all-caps words.
- No emoji, no exclamation marks, no em dashes. Use a colon, a comma or a new sentence instead.
- Never write: best, fastest, seamless, effortless, magic, AI-powered, guaranteed, private.
- Say what happens, plainly, in the reader's terms. Real lines from the project to model on:
  - "A verdict, not a summary."
  - "Evidence you can open."
  - "Every run ends in PASS, FAIL or a refusal with a typed reason and the next action to take."
  - "Your agent says it is done. Did anyone open the app?"
- Address the reader as "you" and their tools as "your agent", "your app". QaReN is "it", never "we".
- Quote plan steps exactly as written: `Tap "onboarding-skip"`, `Wait for "Welcome" to appear`.
- Name other tools in text only (Claude Code, Codex, Cursor, Expo, GitHub). Never their logos or anything that looks like them.
- **No invented claims, numbers or output.** Durations, counts, CLI output and PR comments in mock-ups carry the Placeholder badge and use visible stand-ins ("x.x s", "m:ss", "placeholder: ..."). Remove the badge only when the content is copied from a real run.

## Colour

Two themes: `dark` (the default, and the brand) and `light` (for docs). Use the tokens, never the hex values.

| Token | Use it for | Never use it for |
| --- | --- | --- |
| `bg` | The page ground. | Panels inside the page. |
| `surface` | Cards, code blocks, terminal panes, tables, the nav bar. | The page ground. |
| `surface-2` | Title bars, table header rows, inline code, the current sidebar item. | Large areas. |
| `border` | Hairline dividers and surface outlines. | Anything that must read as a control. |
| `border-strong` | Outlines that identify a control: secondary buttons, inputs, pending-step rings. | Decorative dividers. |
| `text` | Headings, body, code, the wordmark. | |
| `muted` | Captions, metadata, step numbers, pending steps, code comments, the footer. | Body paragraphs, the verdict. |
| `accent` | A fill: the cursor block, the primary button, the running-step marker. | Text on light grounds (1.6:1), large areas, more than one element per screen. |
| `accent-text` | Amber as text or a thin mark: a running step's label, link hover underlines, the focus ring, the caution callout outline. | Body text, links at rest. |
| `pass`, `on-pass`, `pass-tint` | PASS, and only PASS: the pill, the word, passed-step marks, a passed PR header. | Generic success, the brand, buttons, decoration. |
| `fail`, `on-fail`, `fail-tint` | FAIL, and only FAIL: the pill, the word, failed-step marks, failed ledger rows, the danger callout. | Validation errors that are not a verdict, emphasis, decoration. |
| `focus` | The 2px focus ring, offset 2px, on every interactive element. | |

Every text pair meets WCAG AA in both themes; the full table is in the Contrast section. In the light theme, PASS, FAIL, muted and amber text are darker than in dark so they keep 4.5:1.

## Type

Two families, both OFL on Google Fonts. No other fonts.

- **Inter** (`--font-sans`) for headings and body: `display`, `h1`, `h2`, `h3`, `lead`, `body`, `body-sm`. Headings are 600 with slight negative tracking; body is 400 at 1.65 line height.
- **JetBrains Mono** (`--font-mono`) for the wordmark, labels and code: `wordmark`, `verdict`, `label`, `code`, `code-sm`. Plan steps, file names, durations, kickers and table headers are mono.
- Load both from Google Fonts: `Inter:wght@400;500;600` and `JetBrains+Mono:wght@400;500;600;700`.

## Logo

The logo is the **cursor Q**: a Q drawn as a rounded terminal frame, opened at the bottom right where the amber cursor block sits as its tail. It says what QaReN is (a careful operator at a terminal) without borrowing anyone's mark.

- **Symbol** (`Logo`, or `qaren-symbol.svg`): avatars, favicons, app icons, anything under 120px wide. Minimum 16px.
- **Lockup** (`Logo variant="lockup"`, or `qaren-lockup.svg`): the symbol plus the wordmark outlined from JetBrains Mono 600, cap height three quarters of the symbol. Nav bars, headers, social cards, README heroes. Minimum 20px tall.
- **App icon** (`qaren-app-icon.svg`): the symbol on a `bg` tile with 14/64 corners. Favicon and GitHub avatar.
- **Colours:** ring in `text` (`#e8ecf1` on dark, `#0f1720` on light), cursor always `accent`. Mono white and mono black versions exist for single-colour use only.
- **Clear space:** half the symbol's height on every side.
- **Never:** recolour the ring amber, green or red; rotate, outline, add shadows or gradients; put the symbol in a circle or any shape other than the app-icon tile; pair the logo with the wordmark's own cursor block; draw any third-party mark beside it.
- Logo files are in the Logos assets.

## The wordmark

"QaReN", exactly that casing, in JetBrains Mono 600, in `text`. Use the plain `Wordmark` where the logo would be too heavy (footers, inline mentions). It may carry its own amber cursor block, which then counts as the screen's accent. Never QAREN, Qaren or qaren, except the command `qaren` in code.

## Spacing, radius, borders, shadow

- Spacing runs on a 4px base: `space-1` 4 to `space-8` 80. Cards and code pad `space-4` to `space-5`; sections are `space-7` apart.
- Radii are small and calm: `radius-sm` 4 (inline code, badges, cursor), `radius-md` 6 (buttons, code, callouts), `radius-lg` 10 (cards, panes). `radius-pill` belongs to the verdict pill only.
- Every outline is `border-hairline` (1px). Separate with surfaces and hairlines first; use `shadow-pane` only for a pane floating over a hero or social card.

## Motion

- `duration-fast` (120ms) for hover and press, `duration-base` (200ms) for step status changes, both on `ease-standard`. `ease-exit` for things leaving.
- The cursor blinks in steps over `duration-cursor` (1100ms), never a fade. It is the only looping motion.
- Under `prefers-reduced-motion`, the cursor stops and transitions are removed.

## Iconography

- Two glyphs only: a check for passed and PASS, a cross for failed and FAIL, drawn at 16px with a 2.2 stroke in `currentColor`.
- Step marks: a hollow `border-strong` ring for pending, the amber cursor block for running, the check and cross for done.
- No icon library, no emoji, no third-party marks (React, Expo, Apple, GitHub, X, Anthropic, Cursor or lookalikes). Terminal window dots are neutral `border` circles.

## Components

Brand: `Logo`. Verdict components: `VerdictPill`, `StepList`, `VideoProofCard`, `PRCommentSummary`, `LedgerRow`. Core: `Wordmark`, `Button`, `Link`, `CodeBlock`, `InlineCode`, `TerminalPane`, `Card`, `Badge`, `Callout`, `Table`, `NavBar`, `Footer`. Each has its own guidelines. Wrap any page in an element with class `qr-root` and `data-theme="dark"` or `data-theme="light"`; nested `data-theme` blocks switch theme locally.

## Layouts

- **X header, 1500 x 500.** The profile photo covers the bottom-left corner and phones crop top and bottom: keep everything between x 360 and 1410 and y 80 and 420.
- **X profile picture, 400 x 400.** The symbol on `bg`, optically centred for X's circular crop.
- **X post images, 1600 x 900.** 112px side and 104px top and bottom margins. One idea per image: the introduction, or how a check works. Repeat any link in the post text.
- **GitHub social preview, 1280 x 640.** Keep an 80px margin on all sides; GitHub crops edges in some views.
- **Docs page.** Light theme, 760px reading column, sidebar group labels in mono `label`.
- **README hero.** Dark, 880px wide (GitHub's README column). Export it as an image; links go in the Markdown below it.
- Each layout spends at most one UI accent: the README hero on its primary button; the X images, social card and docs page on nothing beyond the logo.
