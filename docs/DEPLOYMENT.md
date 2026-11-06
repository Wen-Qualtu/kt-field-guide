# Production and staging

## Hosting decision

Keep the app static. Use Cloudflare Pages Git integration for two independently
deployed URLs: `main` is production, `staging` is the test environment. A staging
push does not redeploy production. GitHub Pages remains the existing production
mirror during activation; it only deploys `main`.

## Activation status - 2026-11-06

Cloudflare Pages project `kt-field-guide` is connected to GitHub, with app access
limited to this repository. Remote `staging` contains the briefing foundation and
opponent-selection changes. Automatic production deployments are disabled;
preview branch controls include only `staging` (no excludes).
`NODE_VERSION=22` and `PYTHON_VERSION=3.13` are set for both build environments.

During staging-only activation the build command has this additional guard before
the test/build command below:

```sh
if [ "$CF_PAGES_BRANCH" != "staging" ]; then echo "Only staging deployments are currently approved"; exit 1; fi
```

The initial main build is deliberately rejected by that guard. GitHub Pages
production remains untouched. Remove the guard and enable Cloudflare production
only after separate release approval. Branch protection and optional preview
Access policies are not provisioned by this setup.

## Account setup

1. Review and commit the implementation on the existing feature branch, then
   create local `staging` at that reviewed commit without changing `main`.
   Push staging only after separate approval. Test this candidate before
   opening a promotion PR to main; do not deploy the foundation to production
   just to initialize the test environment.
2. In Cloudflare **Workers & Pages**, create a **Pages** project using Git
   integration, not Workers or Direct Upload. Connect GitHub and grant the app
   access only to `Wen-Qualtu/kt-field-guide`. Use project name `kt-field-guide`
   if available; otherwise update the planned URLs in the documentation.
3. Set framework preset **None**, repository root, output directory `public`,
   and the build command below. Set `NODE_VERSION=22` and `PYTHON_VERSION=3.13`
   in both Production and Preview build environments.
4. In **Settings > Builds & deployments**, explicitly set production branch to
   `main`; leave automatic production deployment disabled until staging is
   accepted. For preview deployments
   choose **Custom branches**, include only `staging`, and leave excludes empty.
   Other branches should not deploy automatically.
5. Verify staging at `https://staging.<project>.pages.dev/`. The old main branch
   does not yet have the shared build script, so an initial Cloudflare main
   build may fail during setup; GitHub Pages production remains unchanged.
   After staging acceptance, enable automatic production deployments and merge
   the reviewed staging PR into main. Then verify `https://<project>.pages.dev/`.
   These are planned URLs, not links proven live by local tests.
6. Enable the Pages preview Access policy and restrict it to approved testers
   if staging should be private. Verify both the branch alias and immutable
   preview URLs require login, while production remains public. `noindex`
   discourages crawling; it is not access control.
7. In GitHub, protect `main` and `staging`: require PRs and the `build` check,
   block force pushes and branch deletion, and disable routine bypass. Require
   a production review where practical. Cloudflare has its own deployment
   checks; require its production check too once that check is available.
8. While the GitHub Pages mirror remains enabled, restrict the `github-pages`
   environment to `main` and verify HTTPS. After Cloudflare production is
   accepted, optionally set repository Actions variable
   `PAGES_PRODUCTION_ENABLED=false` to stop future Pages deployments. This does
   not delete the already published Pages site; disable/unpublish it separately
   only after deciding how existing shared links should be handled.

Cloudflare build command (Linux build shell):

```sh
node --test tests/build-site.test.mjs && python -B -m unittest discover -s tests -v && node scripts/build-site.mjs
```

Both suites must pass before packaging. No upstream checkout, sync, extraction,
rendering, npm dependencies or runtime server is involved. Do not add secrets
to Preview: branch build scripts are code under development and can read build
environment variables. Git integration avoids a user-managed deployment token.

## Daily workflow

1. Create a feature branch from staging and open a PR targeting `staging`.
2. Merge after checks pass. Cloudflare automatically updates the stable test URL.
3. Test team summaries, rule expansion, filters and both datacard sides on desktop
   and mobile. If a snapshot changed, verify its content and image references.
4. Open a PR from `staging` to `main`. Preserve merge ancestry rather than squash
   repeated environment-promotion PRs; review the exact release diff and checks.
5. Merge to publish production. Verify the public site after deployment.

If staging advances after acceptance, retest the new candidate before promoting.
For a production hotfix, branch from `main`, release through a reviewed PR, and
merge `main` back into `staging` so the fix is not lost during later promotion.

## Security and rollback

The shared packager refuses symlinks and existing build output, publishes only
the designated static entries, and emits Cloudflare response headers for frame
protection, MIME sniffing prevention, referrer policy and restricted browser
permissions. The header CSP complements the HTML's hash-based script CSP; it
does not replace it. GitHub Pages ignores Cloudflare's `_headers` rules, so the
mirror only has its existing HTML policy.

Staging and production have different origins, keeping browser storage and
service-worker scopes separate. They still share a hosting account and repository;
branch protection and least-privilege account access are essential.

Revert a bad release through a PR to `main`, then propagate that revert to
staging. For urgent recovery, Cloudflare can roll production back to a previous
successful production deployment; reconcile `main` afterwards before another
push. Preview deployment rollback is not a substitute for reverting staging.

## Acceptance checklist

- Main push changes production; staging push changes only the test URL.
- Failed build tests leave the last successful deployment serving.
- An excluded feature branch does not produce a deployment.
- Production and staging load JSON and images with relative URLs.
- Staging responses include `X-Robots-Tag`; production responses do not.
- Cloudflare security headers are present, with no browser CSP errors.
- If enabled, Access protects staging aliases and preview URLs, not production.
- GitHub rejects an unreviewed direct production push.
- A production rollback restores a known-good deployment.

References: [branch controls](https://developers.cloudflare.com/pages/configuration/branch-build-controls/),
[build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/),
and [preview aliases and access](https://developers.cloudflare.com/pages/configuration/preview-deployments/).