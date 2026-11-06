---
name: field-guide-sync
description: "Use when syncing or refreshing KT Field Guide data/images from kt-datacards, changing the exporter or data schema, debugging missing ploys/cards, verifying generated snapshots, or publishing and troubleshooting GitHub Pages."
---

# Sync and publish KT Field Guide

## Architecture

Read [project context](../../../docs/PROJECT-CONTEXT.md) and
[README](../../../README.md). This repo consumes an existing local generated-data
snapshot; it does not execute either kt-datacards pipeline track.

## Procedure

1. Check git status in this repo and confirm the requested source checkout.
   Default is the sibling `kt-datacards`; `--source` supports another location.
2. Inspect [sync.py](../../../scripts/sync.py) and relevant source JSON before
   changing parsing. Source inputs:
   - `config/weapon_rules.json`
   - `output/{team}/data/{team}-team-data.json`
   - `layers/integration/{team}/content/{team}-content.json`
   - Referenced `output/{team}/cards/datacards/*-{front|back}.jpg`
3. Remember integration content can be absent from fresh clones. Do not invent
   empty-success content, rerun extraction, or edit source output to hide a failure.
   Report what is missing and obtain the existing generated content.
4. Preserve IDs, catalog fields, parameterized source wording and relative URLs.
   Unsuffixed images take priority; `card1` is the documented multi-card fallback.
5. Run `python -m unittest discover -s tests -v` for exporter changes; add a focused
   regression to [test_sync.py](../../../tests/test_sync.py) when behavior changes.
6. When a refresh is requested, run:

   ```powershell
   python scripts\sync.py --source C:\git\kt-datacards --strict
   ```

   Adjust the source path as needed. Normal mode allows missing assets with
   warnings and explicit unavailable-content UI; do not claim a complete sync
   unless strict mode or equivalent checks confirm it.
7. Verify snapshot output and inspect the diff:
   - Operative/team counts match the intended source.
   - Every emitted front/back image URL resolves to a copied file.
   - Faction/ploy text is available for intended teams.
   - Repeating the sync gives the same data and preserves custom UI.
   - Cleanup removes only previously managed images, never arbitrary files.
8. Preview via a static HTTP server, not the old Python API server. Test real
   summary and image loading under relative/subpath URLs.
9. Commit and push only when requested/authorized. Push to `main` deploys via
   [pages.yml](../../workflows/pages.yml); Actions tests the exporter and publishes
   `index.html`, `data` and `output`, without running sync or extraction.
10. For deployment, use `gh run list` / `gh run watch` with
    `--repo Wen-Qualtu/kt-field-guide`, then verify the public site:
    https://wen-qualtu.github.io/kt-field-guide/

## Guardrails

- Standard library only, Python 3.10+; no dependency installation needed.
- Never overwrite `index.html` during sync.
- Do not edit committed generated JSON/images by hand.
- Reject malformed input and unsafe paths explicitly.
- Data counts in project context describe the initial snapshot, not fixed tests.
- Explain snapshot freshness and prose-matching limitations to users.
