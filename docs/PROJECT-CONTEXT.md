# KT Field Guide - project context

## Why this exists

The user's description: **"an app that helps you make sense of the opponent team."**
The chosen working name is **KT Field Guide**. Team overview is the main use case,
not merely searching individual datacards.

The project started as a local operative browser in Wen-Qualtu/kt-datacards.
The user found it functionally useful, then asked for clearer grouping and
team-wide summaries. They requested a separate repository so UI development could
evolve independently while reusing already-generated pipeline output.

Repository: https://github.com/Wen-Qualtu/kt-field-guide

Public site: https://wen-qualtu.github.io/kt-field-guide/

Initial setup and public deployment were verified on **2026-11-06**.
Local sibling checkouts at setup:

- `C:\git\kt-field-guide` - this app.
- `C:\git\kt-datacards` - upstream generated-data source.

Those paths are conveniences, not requirements. The sync accepts `--source`.

## Product decisions from the conversation

1. **Understand the team at a glance.** Select a team and see its combined baseline
   stats: APL, movement, save, wounds and base size.
2. **Show distinct values, not averages.** If all operatives have a 4+ save, show
   4+ once. If some have 3+ and others 4+, show both. Expand a value to see which
   operatives have it and how many.
3. **Explain threats with sources.** List weapon rules such as Lethal 5+ and
   Piercing 1. Clicking/expanding a rule reveals contributing operatives and
   weapons, matching abilities, and faction rules or ploys. Ploy/ability text
   should be inspectable so players can read conditions.
4. **Keep precise rule variants.** Do not collapse Lethal 5+ and Lethal 4+, or
   Piercing 1 and Piercing Crits 1, into an ambiguous summary entry.
5. **Keep useful secondary tools.** Operative search, stat/weapon/keyword filters,
   collapsible alphabetically sorted team buckets, selection and front/back
   datacard viewing already work.
6. **Improve UI and mobile next.** The user explicitly said functionality works,
   but UI and mobile layout need improvement. The absence of horizontal overflow
   is only a baseline check, not proof that the mobile experience is finished.
7. **Separate UI from data production.** Sync existing generated files instead
   of running the full pipeline twice. UI changes must survive subsequent syncs.
8. **Keep hosting simple.** The site is static, hosted on GitHub Pages with no
   runtime Python server, database, login or paid service requirement.

## Current implementation map

| Path | Role |
| --- | --- |
| [index.html](../index.html) | Entire UI: inline CSS and JavaScript; summary is default |
| [scripts/sync.py](../scripts/sync.py) | Standard-library exporter and image copier |
| [tests/test_sync.py](../tests/test_sync.py) | Sync contract, repeatability, safety, missing-data and multi-card tests |
| [data/operatives.json](../data/operatives.json) | Browser operative catalog |
| [data/team-content.json](../data/team-content.json) | Team faction rules, firefight/strategy ploys and weapon-rule catalog names |
| [data/sync-manifest.json](../data/sync-manifest.json) | List of managed images for targeted stale-file cleanup |
| [output](../output/) | Only referenced operative card JPG assets |
| [Pages workflow](../.github/workflows/pages.yml) | Tests and publishes existing snapshot on push to main |

Important JavaScript entry points in `index.html`:

- `start()` fetches static JSON using relative URLs.
- `teamSummaryData()` gathers all team baseline stat variants and rule sources.
- `findRuleMentions()` matches catalog rule names/parameters in source prose.
- `renderTeamSummary()` renders expandable values and source details.
- `filteredOperatives()` implements secondary browser filters.
- `renderList()` switches summary/operative views and renders team buckets.
- `renderDetail()` renders the selected operative, weapons, abilities and images.

There is no JS framework, npm build, backend or extra sync dependency today.
Do not assume those are necessary for the next UI improvement.

## Source data and publication

The source repo is **Wen-Qualtu/kt-datacards**. Its pipeline has two extraction
tracks, kt-app and warcom, converging on shared integration/output. This site does
not need to understand or run those extraction tracks.

The sync reads:

- `output/{team}/data/{team}-team-data.json` for operative stats and weapons.
- `layers/integration/{team}/content/{team}-content.json` for faction rules and ploys.
- `config/weapon_rules.json` for known weapon-rule names.
- `output/{team}/cards/datacards/*.jpg` for referenced front/back images.

Integration-layer content can be gitignored and absent from a fresh clone. Sync
from a machine that already has it. Current publication is a committed snapshot,
not a scheduled fetch from upstream or a pipeline run in GitHub Actions.

The exporter preserves the browser's operative API shape, normalizes slugs and
weapon-rule filter families, and emits relative image URLs. It uses `card1`
images when a multi-card operative has no unsuffixed front/back pair.

Sync does not overwrite `index.html`. Stale image deletion is limited to paths
recorded by the previous manifest. `--strict` fails before writes when expected
images or content are missing. Malformed input fails explicitly.

See [README](../README.md) for sync, local preview and publication commands.

## Known limits and cautions

- Prose matching finds **mentions**, not structured proof of a rule grant. It can
  include exceptions, restrictions, negations or unrelated wording. Expose the
  original source; do not promise every listed rule is always available.
- Stats are generated baseline values, not modifications from conditional ploys.
- The full roster is not the same as a legal selected loadout or deployed roster.
- Multi-card navigation uses the synced `cards` list; the refreshed snapshot
   includes all generated pairs while preserving the original first-pair API.
- Snapshot freshness is manual. The app is not authoritative or automatically
  current with official updates.
- The briefing now keeps operative filters out of the summary view and increases
   reading sizes. Continue validating the operative browser on small screens.
- This is an unofficial fan reference. Keep the non-affiliation notice and
  third-party attribution. Do not claim ownership of official rules/artwork.

## Verification baseline, not permanent thresholds

At initial deployment: **48 teams, 453 operatives, 906 referenced images**.
All image references existed; five sync tests passed locally and in Actions.
The public site loaded team summaries, Combat Doctrine source text and operative
images. A 390px viewport had no horizontal overflow.

Counts may legitimately change after future syncs. Verify against the actual
source rather than hard-coding these numbers as an invariant.

## Suggested next work

Prioritize a clearer team-first UI and practical mobile use during a game:
readable summaries, touch-friendly expansion, and less interference from
secondary operative filters. Discuss significant navigation or behavior changes
before implementing them. Preserve rule-source traceability throughout.

This is direction from the conversation, not approval for a specific redesign,
framework migration, roster builder or additional feature.

## Approved foundation session - 2026-11-06

Approved direction: **team briefing**, with composition, equipment, complete rule
reference and multi-card navigation. Keep team comparison, offline support,
favourites and roster-legality checking outside this first slice.

Implementation work is on `feature/team-briefing-foundation`, preserving existing
guidance/documentation. The follow-up approval authorizes a real snapshot refresh
and local staging commit. Push, production merge and deployment remain separate
approvals; main is not changed by preparing staging locally.

The source has `operatives_selection` entries containing source text and parsed
loadout choices. Export these unchanged rather than infer deployed team size from
datacard count. Numeric selection constraints are not yet a dependable structured
contract. For the sampled Angels of Death source, selection text specifies one
leader and five others, while the catalog contains nine datacard types.

The exporter adds a write-free dry-run, path/manifest preflight, nested-content
validation, per-image atomic replacement, additive multi-card indexing, equipment,
selection and relative source traceability. Existing snapshot APIs remain usable.
Strict sync of the sibling checkout refreshed 48 teams, 453 datacard types and
922 images, including 16 additional multi-card images. All emitted image
references pass the snapshot contract check. No extraction or rendering ran.

Infrastructure changes add read-only PR checks, immutable Action pins, a separate
main-only deployment job, and a hash-based HTML Content Security Policy. GitHub
branch/environment protections and HTTPS settings remain to be verified separately.

## Branch-linked environments

Deployment foundation uses `main` as production and `staging` as test. Cloudflare
Pages Git integration is the planned host for independently deployed branch URLs;
GitHub Pages remains a main-only production mirror until a verified transition.
No external hosting setup or remote branch creation has been performed. See
[deployment setup](DEPLOYMENT.md) for exact activation steps and remaining gates.

The dependency-free Node packager is shared by GitHub CI and Cloudflare. It only
publishes designated static files and adds Cloudflare security headers. Both
environments run packaging and Python tests before deploying; neither runs sync.
Preview deployment is limited to `staging`, with no production build secrets.
Keep feature work off main and promote tested changes through staging PRs.
