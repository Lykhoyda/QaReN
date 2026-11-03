# @qaren/design

@qaren/design is a mirror of the QaReN design system in Claude Design: <https://claude.ai/artifact/9wASKvBDC7Lx4ooS66t7YD>. Edit in Claude Design, never here. It is the brand for every QaReN surface; the docs site consumes its tokens.

Every file under `design/` is a file of the artifact's `project/` folder, byte for byte, at version `1793686235-1e19` (`design-source.json` records the version and each file's sha256). The mirror holds only what code consumes: `README.md`, `tokens.css`, `tokens.json`, `contrast.md` and `components/bundle.js`, `bundle.css` and `index.d.ts`. `design-system.json`, the assets, and each component's preview and README stay in Claude Design.

The design guidance is `design/README.md`; this file does not restate it.

## Use it

```tsx
import '@qaren/design/tokens.css';
import '@qaren/design/components.css';
import { VerdictPill } from '@qaren/design';
```

The components come from `design/components/bundle.js` through a build-time wrapper, `scripts/build-adapter.ts`, which writes `dist/index.js` and `dist/index.d.ts` (gitignored; run `build` before using the package). The wrapper gives the bundle React through a module-scoped `window`, so the same file renders on the server and in the browser without touching the global. Props types are the artifact's `index.d.ts`. React 19 is a peer dependency; interactive components such as a `Button` with `onClick` need a client boundary in the consumer.

Fonts: `bundle.css` imports Inter and JetBrains Mono from Google Fonts.

## Update

1. In Claude Design, list the artifact's files and save the version and the sha256 of each mirrored `project/` path as `inventory.json`: `{ "version": "<version>", "files": { "tokens.css": "<sha256>", ... } }`.
2. Read each of those files and save them under one folder, keeping their paths below `project/`.
3. Run `bun scripts/sync-design.ts <folder> --inventory <inventory.json>`. It refuses, before touching anything, when a file is missing, extra, a symlink or differs from its hash; otherwise it replaces `design/` and writes `design-source.json`.
4. Put the new version in this README, run `bun run test`, and commit `design/`, `design-source.json` and the README.

CI fails when `design/` and the lock disagree. It cannot see that Claude Design has a newer version; that needs a sync.

## Scripts

Run with Bun from this directory, or through `corepack yarn workspace @qaren/design <script>` from the repository root.

| Script | What it does |
| --- | --- |
| `build` | Writes the component adapter into `dist/`. |
| `typecheck` | `build`, then `tsc` on the scripts and tests and on the generated `dist/index.d.ts` with library checks on. A component in the bundle header without a matching `<Name>Props` in `index.d.ts` fails here. |
| `test` | `typecheck`, then `bun test` (every component server-rendered, a hydration check on React 19, the scripts), `check-contrast` and `check-mirror`. CI runs it. |
| `check-contrast` | Recomputes every pair in `design/contrast.md` from `design/tokens.json` and fails when a pair is under its floor or the table disagrees with the tokens. Read-only: fix a failure in Claude Design. |
| `check-mirror` | Fails when a file under `design/` is changed, missing, extra or a symlink, or this README does not name the locked version. |
| `sync <folder> --inventory <file>` | The update step above. It never reads the network. |

TypeScript 7 is installed under the alias `typescript7` because Yarn's built-in TypeScript patch does not apply to version 7; `tsc` in this package resolves to it.
