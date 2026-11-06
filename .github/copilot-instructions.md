# KT Field Guide

This app helps players make sense of their opponent's Kill Team. Team overview is
the main use case; operative search and datacard inspection support that goal.

Read [project context](../docs/PROJECT-CONTEXT.md) for product decisions, architecture,
known limitations and next priorities. See [README](../README.md) for commands.

- Keep this a static site compatible with GitHub Pages repository-subpath hosting.
  Use relative fetch and asset URLs; do not introduce a backend without discussing it.
- UI development belongs here, not in the source kt-datacards browser prototype.
- Generated data and images come from kt-datacards via `scripts/sync.py`.
  Do not hand-edit snapshots or rerun the extraction/rendering pipeline here.
- Team summaries use the full team's roster, independent of operative filters.
  Preserve distinct stat values, rule parameters and source traceability.
- A prose rule mention is not necessarily a grant. Preserve conditions and source
  text rather than asserting unconditional access to a rule.
- Preserve existing filters, collapsible team buckets, selection and card viewing.
  Validate UI changes at desktop and mobile widths with browser tools.
- Keep Python sync dependency-free (standard library, Python 3.10+). Test changes
  with `python -m unittest discover -s tests -v`.
- Sync must never overwrite the UI or delete unmanaged assets. Missing content
  must remain visible; malformed input must fail explicitly.
- Do not sync, commit, push or deploy unrelated changes implicitly. A push to
  `main` publishes the site.

Project skills:
- `field-guide-product`: product intent, team overview behavior, UI/mobile work.
- `field-guide-sync`: data contracts, source paths, sync validation and deployment.
