# MT5 chart templates

Chart templates (`.tpl`) exported from MetaTrader 5, kept here so the same chart
setup can be restored on any machine — the Windows box that runs the sync and the
Mac used for reviewing.

| File | Notes |
|------|-------|
| `RED_GREEN.tpl` | Dark background, green/red candles, H1, grid on. Exported from MT5 as `RED_GREEN_ZoneLock_MT4_V2`. |

> MT5 lists a template by its **file name**, not by anything inside the file, so
> this one appears in the Template menu as `RED_GREEN`.

## Install

Copy the `.tpl` into MT5's template folder, then restart MT5 (it reads the folder
at startup) or right-click a chart → **Template** → the name appears in the list.

- **Windows:** MT5 → *File → Open Data Folder* → `MQL5\Profiles\Templates\`
- **macOS:** the same path inside MT5's Wine bottle, e.g.
  `~/Library/Application Support/net.metaquotes.wine.metatrader5/drive_c/Program Files/MetaTrader 5/MQL5/Profiles/Templates/`

The exact location depends on whether MT5 runs in portable mode — *Open Data
Folder* always lands in the right place, so prefer that over typing the path.

## Applying it

Right-click a chart → **Template** → pick the name. Or drag it onto a chart.

## Caveats

- A `.tpl` stores chart appearance plus the *list* of indicators and their inputs.
  It does **not** contain indicator code: if a template references a custom
  indicator, that indicator's `.ex5` must also be present in `MQL5/Indicators/`
  or MT5 loads the chart without it, silently. This template only references
  `main` (the price series itself), so it has no such dependency.
- The `symbol=` and `period=` lines record the chart it was saved from
  (`XAUEUR-VIP`, H1 here). Applying the template to another chart keeps that
  chart's own symbol — those fields are not forced onto it.
