# anti-slop provenance

QaReN vendors the contents of upstream `src/` unchanged into `tools/oxlint/anti-slop/`.
The pinned commit is `63dbb09f73438e550a6991dc6d778f979ffbf183` and its `src/` tree is
`09835da74fb414e29458e9e42022a98b5e2a8fad`. [Upstream anti-slop](https://github.com/dmmulroy/anti-slop/tree/63dbb09f73438e550a6991dc6d778f979ffbf183)

The upstream MIT license is copied to [LICENSE](LICENSE). The vendored stylistic rules carry
their own [license](vendor/eslint-stylistic/LICENSE) and [provenance](vendor/eslint-stylistic/UPSTREAM.md).
The local `package.json` marks this directory as a private ES module package so Node 24
can load the generic entry point, `index.ts`.

## Initial lint policy

At QaReN commit `d550edc3220a3fbdc4e22789a5451a7de927dc41`, Oxlint 1.78.0 checked
795 files. Four generic rules and the native Oxlint companion had zero findings.
The other 14 generic rules accounted for 29,089 diagnostics. File counts are distinct
within each rule.

| Rule | Diagnostics | Files with findings | Initial setting |
| --- | ---: | ---: | --- |
| `anti-slop/no-array-filter-map` | 34 | 23 | off |
| `anti-slop/no-reduce-accumulator-copy` | 0 | 0 | error |
| `anti-slop/no-chained-type-assertions` | 63 | 31 | off |
| `anti-slop/no-conditional-empty-object-spread` | 807 | 155 | off |
| `anti-slop/no-known-value-widening` | 225 | 99 | off |
| `anti-slop/no-module-mocking` | 0 | 0 | error |
| `anti-slop/no-object-parameters` | 31 | 24 | off |
| `anti-slop/no-reflect-apply` | 11 | 7 | off |
| `anti-slop/no-reflect-get` | 23 | 6 | off |
| `anti-slop/no-runtime-typeof` | 808 | 199 | off |
| `anti-slop/no-unsafe-dictionary-type` | 467 | 147 | off |
| `anti-slop/no-shape-in-symbol-names` | 242 | 29 | off |
| `anti-slop/no-unknown-parameters` | 334 | 129 | off |
| `anti-slop/no-unknown-returns` | 90 | 49 | off |
| `anti-slop/no-unknown-type-aliases` | 0 | 0 | error |
| `anti-slop/no-widen-then-assert` | 0 | 0 | error |
| `anti-slop/require-readable-spacing` | 24586 | 726 | off |
| `anti-slop/require-safety-comment-for-type-assertion` | 1368 | 273 | off |
| `oxc/no-accumulating-spread` | 0 | 0 | error |

## Updating

Diff upstream against the recorded commit, copy the new source tree and retain both
license notices. Verify the copied bytes, remeasure the rules on the full lint input
set, and update the pins, counts and policy here.
