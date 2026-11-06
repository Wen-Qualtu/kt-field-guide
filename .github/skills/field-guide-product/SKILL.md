---
name: field-guide-product
description: "Use when working on KT Field Guide product goals, team overview, opposing-team analysis, stat summaries, rule sources, operative browsing, UI redesign or mobile layout; also when starting a fresh session or asking what this app is for."
---

# KT Field Guide product and UI

## Goal

Help a player understand the opponent's team: baseline stat variations, threats,
and where weapon rules come from. Team summary is primary; operative inspection
is supporting functionality.

## Procedure

1. Read [project context](../../../docs/PROJECT-CONTEXT.md) and
   [README](../../../README.md). Identify which product decision the request serves.
2. Inspect the relevant HTML/CSS/JavaScript in [index.html](../../../index.html)
   before editing. It currently contains the complete frontend.
3. Preserve these contracts:
   - Summary stats use checked opponent operative types (all by default), not
     browser matches. Keep selections independent per team for the current session.
   - Show each distinct baseline stat value once, with its operative sources.
   - Keep parameterized rules distinct and expose weapons/abilities/ploy sources.
   - Matching prose is only a mention; original wording explains applicability.
   - Keep existing filters, team collapse behavior, selection and card viewing.
4. For a significant navigation/design decision, clarify the intended behavior.
   Prefer simple static HTML/CSS/JS changes unless a larger change is justified.
5. Preview with `python -m http.server 8767 --bind 127.0.0.1` from the repo root.
   Use a browser to test a team with shared and mixed stats, expand a weapon rule
   and ploy, switch back to operatives, and view both card sides.
6. Validate narrow mobile and desktop widths. Check overflow, text readability,
   touch targets, keyboard operation, and access to summaries without wading
   through irrelevant filters. Overflow alone is not a mobile UX acceptance test.
7. Keep asset/fetch URLs relative for `/kt-field-guide/` hosting. Do not add API
   calls that depend on the old local Python browser server.
8. Update directly affected documentation and report measured checks and limits.

## Useful test cases

- Angels of Death: shared APL/save, multiple movement/wound/base values.
- Balanced: expand Combat Doctrine and read the source text.
- Lethal 5+: expand and inspect contributing weapons/operatives.
- Any multi-card operative: current viewer uses the first card pair only.
- No selected team: explicit prompt to choose one.
- Switch views after filtering: summary keeps opponent selections; browser filters remain.

Use `field-guide-sync` for generated data, source paths or deployment changes.
