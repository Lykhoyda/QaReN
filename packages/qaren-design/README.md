# @qaren/design

The QaReN design system, **Verdict Log: a calm terminal at night**, as a workspace package: colour, type and spacing tokens, the component stylesheet, and typed React components. It is the brand for every QaReN surface; the docs site consumes its tokens.

This package is the canonical copy. The design source stays where new layouts are drawn; changes reach this package through `scripts/sync-design.ts` and a reviewed pull request. Imported from design source version `1793660106-9400` (tokens synced 2026-11-02).

## Contents

| File | What it is |
| --- | --- |
| `tokens.json` | Every token with its usage rule. The source for the contrast check. |
| `tokens.css` | The tokens as CSS custom properties for the `dark` and `light` themes, plus the type classes (`display`, `h1` to `h3`, `lead`, `body`, `body-sm`, `wordmark`, `verdict`, `label`, `code`, `code-sm`). |
| `components.css` | Component styles. The design source's `bundle.css` without its font import, followed by the package-owned docs layout section. |
| `contrast.md` | Every text and mark pair with its WCAG 2 ratio in both themes. |
| `src/` | The components, ported from the design source's `bundle.js` against its `index.d.ts` prop contract. |

## Use it

```tsx
import '@qaren/design/tokens.css';
import '@qaren/design/components.css';
import { DocsLayout, VerdictPill } from '@qaren/design';
```

Load the two font families in the document head. The stylesheets make no network request of their own:

```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link
  rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap"
/>
```

Wrap a page in an element with class `qr-root` and `data-theme="dark"` (the brand) or `data-theme="light"` (docs). A nested `data-theme` switches the theme locally. `DocsLayout` renders its own light `qr-root`.

The package exports TypeScript source (`src/index.ts`); the consumer's bundler compiles it. React 19 is a peer dependency.

### Components

Brand: `Logo`. Verdict: `VerdictPill`, `StepList`, `VideoProofCard`, `PRCommentSummary`, `LedgerRow`. Core: `Wordmark`, `Button`, `Link`, `CodeBlock`, `InlineCode`, `TerminalPane`, `Card`, `Badge`, `Callout`, `Table`, `NavBar`, `Footer`. Layout: `DocsLayout`.

```tsx
<DocsLayout
  nav={{ links: [{ label: 'Docs', href: '/QaReN/', active: true }] }}
  groups={[{ label: 'How QaReN works', items: [{ label: 'Write a plan', href: '/QaReN/plans/', active: true }] }]}
  footer={{ links: [{ label: 'GitHub', href: 'https://github.com/Lykhoyda/QaReN' }] }}
>
  <p className="label">How QaReN works</p>
  <h1 className="h1">Write a plan</h1>
</DocsLayout>
```

`DocsLayout` is the design source's DocsPage layout: the nav bar, a 256px sidebar whose current item is marked by `surface-2` and weight 600, a reading column capped at 760px, and the footer. At 860px wide or narrower the sidebar stacks above the column. The page kicker, title and body are page content, not part of the layout.

## Composition rules

Components provide the styles and status labels; the consuming page owns visual hierarchy and the accent count.

1. **The verdict is the loudest element.** Choose the `VerdictPill` size and surrounding content so the verdict dominates the page.
2. **The verdict is always a word.** PASS or FAIL with a check or cross; every step and ledger row writes its status (`pending`, `running`, `passed`, `failed`) as text. Never colour alone.
3. **One accent per screen.** A primary button, a running step, a caution callout or a logo or wordmark cursor: pick one. `NavBar` includes an amber logo cursor, so `DocsLayout` already uses the accent; keep its action secondary and omit additional accent elements in its content.
4. **No invented output.** `PRCommentSummary` and `TerminalPane` show a Placeholder badge until `placeholder={false}`; set it only for content copied from a real run. `CodeBlock` shows the badge only with `placeholder`: pass it for any block that shows invented output.

The full guidance (voice, colour, type, logo, motion, layouts) lives in the design source.

## Scripts

Run with Bun from this directory, or through `corepack yarn workspace @qaren/design <script>` from the repository root.

| Script | What it does |
| --- | --- |
| `test` | `tsc --noEmit`, then `bun test` (one render test per component), then `check-contrast`. CI runs it. |
| `check-contrast` | Recomputes the table in `contrast.md` from `tokens.json` and fails when a pair is under its floor (4.5:1 text, 3:1 marks) in either theme, or when `contrast.md` no longer matches the tokens. `--write` rewrites the table. |
| `sync <path>` | Refreshes `tokens.css`, `tokens.json`, `contrast.md` and `components.css` from a saved copy of the design source's `project/` folder on local disk, keeps the package-owned docs layout section, and lists what changed. It never reads the network. Components are ported by hand from `components/bundle.js` and `index.d.ts`. |

TypeScript 7 is installed under the alias `typescript7` because Yarn's built-in TypeScript patch does not apply to version 7; `tsc` in this package resolves to it.
