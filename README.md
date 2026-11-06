# KT Field Guide

An unofficial Kill Team reference to help you understand your opponent's team:
stat variations, weapon rules, and the operatives, faction rules and ploys behind them.
Team summary is the default view; the operative browser and datacard viewer remain available.

## Sync existing data

Requires Python 3.10+ and an existing local kt-datacards checkout with generated output.
No extra Python dependencies, extraction, rendering or pipeline run is required.

```powershell
python scripts\sync.py --source C:\git\kt-datacards
```

With sibling checkouts the source defaults to `..\kt-datacards`.
The script replaces the generated JSON in [data](data/) and copies only operative
front/back JPG images into [output](output/). It never overwrites [index.html](index.html).
For multi-card operatives, the viewer uses the generated `card1` front/back images;
the operative stats and abilities still cover the combined operative data.
Images removed from the source are removed only if they were recorded by an earlier sync.
Malformed data fails explicitly; missing images/content produce warnings. Use `--strict`
to reject missing assets before any writes. The UI explicitly reports unavailable images/content.
Integration-layer content is local and may not be included in a fresh kt-datacards clone.
Run the sync from the machine that already has the generated content.

Review and publish the update:

```powershell
git status --short
git add data output
git commit -m "chore(data): sync generated team reference"
git push
```

Syncing is manual so source changes do not silently change the public rules reference.
GitHub Actions only publishes the existing snapshot; it does not run either pipeline.

## Preview locally

```powershell
python -m http.server 8767 --bind 127.0.0.1
```

Open http://127.0.0.1:8767/ rather than opening the HTML file directly.
All fetches and asset paths are relative, so the site also works under GitHub Pages'
repository subpath. No backend, accounts or database are required.

## Deployment

The [Pages workflow](.github/workflows/pages.yml) deploys on pushes to `main`.
In repository Settings > Pages, select **GitHub Actions** as the build source.
Only the HTML, data and operative images are uploaded as the public site.

Expected URL: https://wen-qualtu.github.io/kt-field-guide/

## Data limitations

This is a synced snapshot, not a live feed of official rule updates. Stats represent
the whole team roster, regardless of search/stat filters in the operative browser.
Rule sources in prose are found by matching weapon-rule names and values; a mention
is not proof that a rule is always granted. Read the expanded source for restrictions,
conditions, exceptions and duration. Use official publications for authoritative rules.

Unofficial fan reference, not affiliated with Games Workshop. Kill Team names,
rules and artwork remain the property of their respective owners. No rights to
third-party content are asserted by this project.
