# Contrast

Every text and verdict pair in the system, measured with the WCAG 2 formula from the values in `tokens.json`. Text needs 4.5:1; marks that carry meaning (focus ring, control outlines, step marks) need 3:1. Decorative rows are listed so nobody mistakes them for text pairs.

| Pair | Where it appears | Floor | Dark | Light (docs) |
| --- | --- | --- | --- | --- |
| `text` on `bg` | Body and headings on the page | 4.5:1 | 16.20:1 (pass) | 16.66:1 (pass) |
| `text` on `surface` | Body in cards, code, terminal | 4.5:1 | 14.59:1 (pass) | 18.05:1 (pass) |
| `text` on `surface-2` | Inline code, table headers | 4.5:1 | 13.20:1 (pass) | 15.48:1 (pass) |
| `muted` on `bg` | Captions, footer | 4.5:1 | 7.46:1 (pass) | 5.72:1 (pass) |
| `muted` on `surface` | Metadata in cards, code comments | 4.5:1 | 6.72:1 (pass) | 6.19:1 (pass) |
| `muted` on `surface-2` | Table header labels | 4.5:1 | 6.08:1 (pass) | 5.31:1 (pass) |
| `accent-text` on `bg` | Running step label, link hover | 4.5:1 | 10.80:1 (pass) | 5.47:1 (pass) |
| `accent-text` on `surface` | Running step label in a pane | 4.5:1 | 9.73:1 (pass) | 5.93:1 (pass) |
| `on-accent` on `accent` | Primary button label | 4.5:1 | 10.80:1 (pass) | 10.80:1 (pass) |
| `pass` on `bg` | The word PASS on the page | 4.5:1 | 10.25:1 (pass) | 4.99:1 (pass) |
| `pass` on `surface` | The word PASS in a pane | 4.5:1 | 9.24:1 (pass) | 5.40:1 (pass) |
| `pass` on `pass-tint` | PASS in a passed row or PR header | 4.5:1 | 8.18:1 (pass) | 4.74:1 (pass) |
| `on-pass` on `pass` | PASS pill | 4.5:1 | 10.25:1 (pass) | 5.40:1 (pass) |
| `fail` on `bg` | The word FAIL on the page | 4.5:1 | 6.93:1 (pass) | 5.02:1 (pass) |
| `fail` on `surface` | The word FAIL in a pane | 4.5:1 | 6.24:1 (pass) | 5.44:1 (pass) |
| `fail` on `fail-tint` | FAIL in a failed row, danger callout title | 4.5:1 | 6.12:1 (pass) | 4.61:1 (pass) |
| `on-fail` on `fail` | FAIL pill | 4.5:1 | 6.93:1 (pass) | 5.44:1 (pass) |
| `text` on `pass-tint` | Body on a passed row | 4.5:1 | 12.92:1 (pass) | 15.83:1 (pass) |
| `text` on `fail-tint` | Body on a failed row or danger callout | 4.5:1 | 14.30:1 (pass) | 15.30:1 (pass) |
| `muted` on `pass-tint` | Metadata on a passed row | 4.5:1 | 5.95:1 (pass) | 5.44:1 (pass) |
| `muted` on `fail-tint` | Metadata on a failed row | 4.5:1 | 6.59:1 (pass) | 5.25:1 (pass) |
| `focus` on `bg` | Focus ring on the page | 3:1 | 10.80:1 (pass) | 5.47:1 (pass) |
| `focus` on `surface` | Focus ring in a card | 3:1 | 9.73:1 (pass) | 5.93:1 (pass) |
| `border-strong` on `bg` | Secondary button outline | 3:1 | 4.24:1 (pass) | 3.44:1 (pass) |
| `border-strong` on `surface` | Control outline in a card | 3:1 | 3.82:1 (pass) | 3.73:1 (pass) |
| `pass` on `surface` | Passed step mark | 3:1 | 9.24:1 (pass) | 5.40:1 (pass) |
| `fail` on `surface` | Failed step mark | 3:1 | 6.24:1 (pass) | 5.44:1 (pass) |
| `accent` on `bg` | Cursor block, primary button fill edge | none | 10.80:1 (n/a) | 1.64:1 (n/a) |
| `border` on `bg` | Hairline divider | none | 1.52:1 (n/a) | 1.29:1 (n/a) |
| `pass` on `fail` | PASS against FAIL (hue alone) | none | 1.48:1 (n/a) | 1.01:1 (n/a) |

## Reading the decorative rows

- `accent` is a fill, not a text colour. On the light ground it is 1.6:1, which is why amber text in the light theme uses `accent-text` and a primary button is identified by its label (10.8:1), not by its fill edge.
- `pass` and `fail` differ mainly in hue, and only slightly in lightness. That is acceptable only because a verdict is always written as the word PASS or FAIL, with a check or cross glyph beside it. Never let colour carry the verdict on its own.
- `border` hairlines are dividers. Anything that must be seen as a control uses `border-strong`.
