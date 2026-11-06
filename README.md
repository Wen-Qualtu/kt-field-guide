# KT Field Guide

An unofficial Kill Team reference to help you understand your opponent's team:
stat variations, weapon rules, and the operatives, faction rules and ploys behind them.
Team summary is the default view; the operative browser and datacard viewer remain available.

## Starting a fresh AI session

Open this repository as the VS Code workspace. The
[Copilot instructions](.github/copilot-instructions.md) provide concise project guidance.
Read [project context](docs/PROJECT-CONTEXT.md) for the goals and decisions from
the original conversation, current architecture, limitations and next priorities.

Two project skills provide on-demand workflows:

- [field-guide-product](.github/skills/field-guide-product/SKILL.md): team-overview
  intent, product behavior and UI/mobile validation.
- [field-guide-sync](.github/skills/field-guide-sync/SKILL.md): source data, sync
  contracts, tests and GitHub Pages publication.

## Sync existing data

Requires Python 3.10+ and an existing local kt-datacards checkout with generated output.
No extra Python dependencies, extraction, rendering or pipeline run is required.

```powershell
python scripts\sync.py --source C:\git\kt-datacards
```

With sibling checkouts the source defaults to `..\kt-datacards`.
The script replaces the generated JSON in [data](data/) and copies only operative
front/back JPG images into [output](output/). It never overwrites [index.html](index.html).
For multi-card operatives, sync indexes all numbered card pairs in numeric order.
Unsuffixed front/back images take priority when present; otherwise the first
numbered pair is the default. The viewer includes a card-pair selector.
Images removed from the source are removed only if they were recorded by an earlier sync.
Malformed data fails explicitly; missing images/content produce warnings. Use `--strict`
to reject missing assets before any writes. The UI explicitly reports unavailable images/content.
Integration-layer content is local and may not be included in a fresh kt-datacards clone.
Run the sync from the machine that already has the generated content.

Review and publish the update:

```powershell
python -B scripts\sync.py --source ..\kt-datacards --strict --dry-run
```

Review the dry-run before authorizing a real sync. Work on a feature branch,
review the diff, and obtain separate approval for commit, merge and publish.
Promote through `staging` (test) to `main` (production). Pushing to `main`
publishes the site; do not use it for experimental changes.

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

Use `main` for production and `staging` for testing. Cloudflare Pages Git
integration provides independent branch URLs without adding a backend or
deployment tokens to GitHub. GitHub Pages cannot provide two independent sites
in one repository; GitHub environment names alone do not change that.

| Environment | Branch | Planned URL (subject to project-name availability) |
| --- | --- | --- |
| Production | `main` | https://kt-field-guide.pages.dev/ |
| Staging | `staging` | https://staging.kt-field-guide.pages.dev/ |

The repository is prepared for this setup, but the Cloudflare project, branch
settings and URLs are **not yet provisioned or verified**. Follow
[environment setup](docs/DEPLOYMENT.md) to activate them. Feature work goes through
a PR into staging, browser acceptance at the test URL, then a PR into main.
The committed snapshot travels with the code; deployments never run data sync.

The [workflow](.github/workflows/pages.yml) checks `main`, `staging` and PRs.
The [packager](scripts/build-site.mjs) builds only HTML, data, images and static
hosting headers. Cloudflare runs the same tests before packaging; a failing test
prevents that deployment. Staging has separate URLs and `noindex` headers.
It is public unless Cloudflare Access is enabled.

The existing production URL https://wen-qualtu.github.io/kt-field-guide/ stays
available through the main-only GitHub Pages deployment during setup. In
Settings > Pages, its source remains **GitHub Actions**. Only the separate
main deployment job receives Pages/OIDC write permissions. To stop this legacy
deployment after Cloudflare production is verified, set the GitHub Actions
repository variable `PAGES_PRODUCTION_ENABLED` to `false`.

Branch protection, Cloudflare Git integration, staging access policy and GitHub
environment restrictions require account-level setup; repository files cannot
activate those controls. Actions are pinned; checkout does not retain credentials.

## Data limitations

This is a synced snapshot, not a live feed of official rule updates. Stats represent
the checked opponent operative types (all checked initially), independently of
search/stat filters in the operative browser. Uncheck absent types in the briefing;
Select all/none offers quick resets. Choices persist per team while the page is open,
not across reloads. No model counts, weapon loadout or roster legality are inferred.
Shared faction rules, equipment and ploys remain visible as potential sources.
Rule badges identify weapon (W), ability (A), equipment (E), faction rule (FR),
firefight ploy (FP) and strategy ploy (SP) sources, including combinations.
Repeated card headings are hidden in displayed descriptions only when matched;
synced source text remains unchanged.
Rule sources in prose are found by matching weapon-rule names and values; a mention
is not proof that a rule is always granted. Read the expanded source for restrictions,
conditions, exceptions and duration. Use official publications for authoritative rules.

Unofficial fan reference, not affiliated with Games Workshop. Kill Team names,
rules and artwork remain the property of their respective owners. No rights to
third-party content are asserted by this project.

## Team briefing foundation

The briefing separates **datacard types** from **operative selection**. Selection
text and parsed loadout choices are exported from upstream `operatives_selection`;
there is no guessed team-size calculation or roster-legality engine. Equipment,
faction rules and both ploy types have their own complete reference sections.
Missing sections remain explicit until an approved snapshot refresh supplies them.

Keep images under `output/{team}/cards/datacards/` with relative POSIX URLs.
The `cards` list adds multi-card support while `frontImage` and `backImage` remain
compatible with the original snapshot. No duplicate thumbnails or re-rendering
pipeline are introduced. Source paths and generation timestamps accompany content;
generation time is not an official rules-version date.

Sync validates the catalog, prior manifest and destination paths before writes.
Image replacement is atomic per file and cleanup only removes previously managed
images. The entire multi-file snapshot is not a transaction: an I/O failure can
still require rerunning sync. Never publish an interrupted or unverified refresh.

The HTML uses a hash-based script Content Security Policy and local-only image
URLs. After changing inline JavaScript, update its SHA-256 policy hash; the unit
tests reject a stale hash. GitHub Pages does not support arbitrary security headers,
so this meta policy is not a substitute for repository and environment controls.
