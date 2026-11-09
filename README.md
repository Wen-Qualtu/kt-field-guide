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
search/stat filters in the operative browser. Opponent setup separates Operatives,
Equipment and Ploys into tabs, with Select all and Clear for the current category.
Equipment choices apply across all turning points; strategy and firefight ploy
choices are independent for turning points 1-4. Every category starts fully checked.
Choices persist per team while the page is open, not across reloads. Excluded
equipment and ploys no longer contribute rule sources or briefing reference entries;
their full text stays available in setup. Faction rules remain potential sources.
Ploy selection tracks threats to consider, not legal activation, CP spending,
duration, model counts or weapon loadouts. New turning points start fully checked,
rather than inferring that a previous ploy remains active.
Rule badges identify weapon (W), ability (A), equipment (E), faction rule (FR),
firefight ploy (FP) and strategy ploy (SP) sources, including combinations.
For v1, summary/filter tags are limited to the supplied core weapon-rule catalog
and documented variants such as Seek Light and Heavy movement restrictions.
Custom weapon/ability rule text remains on datacards but does not expand the tag
catalog. Ordinary stat changes are not inferred weapon-rule grants.
Badges sit directly after trait names. Operative names in expanded stat and rule
sources open a datacard dialog with the same side and multi-card controls as the
operative browser; closing it preserves the briefing and browser filters.
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

## Semantic review prototype

The report-only [review harness](scripts/review-data.mjs) stages raw source JSON
under `staging/`, assigns review tasks under a fixed [policy](review/policy.md),
and generates a separate `app-data/candidate/` dataset plus findings under
`review/reports/`. It does not replace the live `data/` snapshot or publish assets.

```powershell
node scripts/review-data.mjs prepare --source ..\kt-datacards --work staging/semantic-review-full --all
# Review workers write the assigned result files before finalize.
node scripts/review-data.mjs finalize --work staging/semantic-review-full
```

Workers interpret meaning and propose exact flavour/heading removals; they may
not edit policy or app data. Policy changes belong in a human-led session and
require a version bump. Validators check full coverage, evidence, output schema,
and frozen run inputs; they do not prove semantic correctness.

Change detection uses stored source timestamps, not content hashes. Current
exports have a team-level `generated_at`, inherited by cards without their own
timestamp. Team/integration/catalog changes and policy/review-version changes
invalidate reuse. The catalog uses file modification time when it has no JSON
timestamp. `--all` forces reanalysis. This trusts source timestamp maintenance;
text edited without updating its timestamp needs a forced full review.

Successful finalize stores reusable decisions in `staging/review-state.json`.
Staging and audit data stay outside public output. The current prototype uses
Copilot workers in an assisted session; unattended model-runner integration and
unattended promotion remain separate work. The accepted curated snapshot is now
assembled into `app-data/current/`, committed, and read by the UI. The static build
publishes only this current snapshot and its release manifest, never staging or
trial candidates. A compatibility `data/` copy in the built site contains the same
reviewed JSON; the repository's original `data/` remains an untouched source snapshot.

The first full trial reviewed all 1,207 parent cards across 48 teams, proposing
750 card cleanups and suppressing 195 lexical source associations. These are
reviewed proposals, subsequently refined by targeted passes before acceptance. An unchanged-source
follow-up queued zero tasks.

Use the single [current uncertainty list](review/reports/uncertainties.md), updated
automatically by each successful finalize. Its JSON companion maintains open entries
and their original numbers. Targeted passes replace only their reviewed cards;
full passes replace the entire list. Resolved entries disappear, so numbering can
have gaps. Untouched cards retain their previous review, not a new whole-source
assessment. The maintained list is the source of truth for current open counts;
completed retries remove resolved findings without creating new lists.

Per-pass reports and learning notes stay in their `staging/` run folders rather
than creating more review lists. Exact-ID retries use repeated `--only-record`
arguments and keep candidate output and the shared review cache isolated.

Policy version 6 enforces a pre-agent bypass: operative-selection and explicit
token/marker-guide cards are copied exactly before worker batching. They never
appear in worker tasks or contexts, require no agent result, and receive no cleanup
or semantic metadata. Real Markerlights rules and operative Guides are not excluded
by a loose name match.

Other cards route segments to `weapon-review` only for known core-rule matches,
otherwise `copy-only` with optional safe flavour cleanup. The worker starts from
the complete parent and ordered `logicalText`; per-field segments are evidence
locations, not independent rules. A continuation in another name/body/option is not
missing source. Copy-only text cannot create weapon-review blockers; ordinary
costs, stat changes and source-layout notes remain nonblocking.

The real bypass check copied all 47 selection-card objects exactly with zero
tasks/results. Remaining old findings were refreshed under the corrected context;
consult the single current list for what is still unresolved.

## Curated Acceptance Data

After all findings are resolved, assemble the full review and ordered targeted
corrections locally:

```powershell
node scripts/assemble-app-data.mjs --dry-run
node scripts/assemble-app-data.mjs
```

The assembler checks source revisions, complete scoped review coverage, zero
unresolved effects, unchanged profiles and image references. It preserves the exact
automatic copies and strips private audit fields. Human-confirmed card evidence is
stored separately in `review/clarifications.json`, never as team-specific policy.
The release manifest records mixed review provenance; it does not pretend every
card was analysed under the latest policy or prove semantic correctness.

Release hashes verify packaged artifact integrity, not source-change detection,
which remains timestamp-based. The current release is acceptance-only; packaging
it on `main` fails until production is explicitly approved. CI packages committed
app data and never runs model review or upstream extraction.
