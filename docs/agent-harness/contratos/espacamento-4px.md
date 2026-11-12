# Seraphine design: 4px spacing rule

The owner asked that every spacing value in the Seraphine design be a multiple
of 4px. Today about half are not (10px is the most common offender, then 14, 6,
2, 22 and 18). Three people are converting three separate sets of files with
this same rule, so the result must be identical wherever the same pattern
appears. Do not improvise a different mapping; if a case is not covered, apply
"nearest multiple of 4, ties decided by the table below" and list it in your report.

## Scale

`0, 4, 8, 12, 16, 20, 24, 32, 40, 48, 64` px. Every spacing value must be a
multiple of 4; prefer a value from this scale.

## What counts as spacing

`padding` (all forms), `margin` (all forms), `gap`, `row-gap`, `column-gap`.

## What is NOT changed

Border widths, font sizes, line heights, letter spacing, border radii, icon and
avatar sizes, widths and heights (control heights 36, 40 and 44px and the 264px
sidebar already follow the rule), SVG coordinates, shadows, outline widths and
offsets, and the visually-hidden text pattern (`width: 1px; height: 1px`, and
`margin: -1px` when it is part of that pattern). Colours, copy, structure and
class names are not touched either.

## Mapping

Every off-grid value in use is exactly halfway between two grid values, so the
direction is fixed per kind of property:

| current | gap and margin | padding, single value (all sides) | padding, vertical side | padding, horizontal side |
|---|---|---|---|---|
| 1px | 0 | 0 | 0 | 0 |
| 2px | 4px | 4px | 4px | 4px |
| 3px | 4px | 4px | 4px | 4px |
| 5px | 4px | 4px | 4px | 4px |
| 6px | 8px | 8px | 4px | 8px |
| 7px | 8px | 8px | 8px | 8px |
| 9px | 8px | 8px | 8px | 8px |
| 10px | 8px | 12px | 8px | 12px |
| 14px | 12px | 16px | 12px | 16px |
| 18px | 16px | 16px | 16px | 20px |
| 22px | 24px | 24px | 20px | 24px |
| other | nearest multiple of 4 (a tie rounds up) | same | same | same |

"Vertical side" means the first value of a two-value shorthand, the first and
third of a three- or four-value shorthand, and `padding-top`, `padding-bottom`,
`padding-block`. "Horizontal side" means the second value of a two- or
three-value shorthand, the second and fourth of a four-value shorthand, and
`padding-left`, `padding-right`, `padding-inline`. Negative margins keep their
sign and follow the gap-and-margin column.

Examples: `padding: 10px 14px` becomes `8px 16px`; `padding: 0 10px 0 22px`
becomes `0 12px 0 24px`; `padding: 1px 8px` becomes `0 8px`; `padding: 14px 24px`
becomes `12px 24px`; `padding: 12px 14px` becomes `12px 16px`; `gap: 10px`
becomes `8px`; `gap: 2px` becomes `4px`; `padding: 14px` becomes `16px`.

## The one judgement call allowed

After converting, if a control with a fixed or minimum height would no longer
fit its content, or a label in a fixed-width area (the 264px sidebar is the
known risk) would be cut off because horizontal padding grew, choose the other
grid neighbour for that one declaration and list it in your report with the
reason. Otherwise follow the table.

## Design system tokens

Spacing tokens are named by their pixel value. The new set is `space-4, space-8,
space-12, space-16, space-20, space-24, space-32, space-40, space-48`. The
tokens `space-2, space-6, space-10, space-14, space-18, space-22` are removed,
and every use of them is converted with the table above according to the
property it sits in.
