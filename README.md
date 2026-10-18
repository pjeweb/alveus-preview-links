# Alveus preview links

> this is just vibe coded. do not use ;)

<img src="assets/bot-icon-512.png" width="128" height="128" alt="Alveus Preview Links robot bird mascot" />

A standalone personal GitHub automation that adds useful Vercel preview links to
all open PRs in `alveusgg/alveusgg`. No changes to the Alveus repository, Vercel
account, database, or deployment process are needed.

It reads GitHub's Vercel deployment statuses, waits for a successful preview of
the PR's **current head commit**, traces changed UI files through static runtime
imports to Next.js pages, and selects at most six links. It follows relative and
`@/` imports, barrel exports, dynamic imports with literal paths, and assets.
Type-only imports and server/env plumbing are excluded. A trace stops at pages
instead of following their exports back into navigation and the application shell.

Directly changed pages take priority; otherwise the nearest UI consumers are
used. The limit is not a quota: a one-page change gets one page, not five extra
shared-dependency guesses. Broad changes are sampled across site areas. A purely
global application change gets at most three representative pages. Deleted
pages, API routes, authentication endpoints, and unresolved dynamic URLs are
omitted. Backend-only changes without supported page links get no comment.

Comments are visibly headed **🤖 Automated preview links** and attributed to this
automation. With a personal access token, GitHub still displays the token owner's
username; a separate bot identity requires a GitHub App or a dedicated account.

One marked comment per PR is updated on later deployments. If a new analysis no
longer supports any links, the bot removes its obsolete marked comment. An unchanged
deployment is skipped before downloading source or calling an AI model. The
comment records the deployment, head SHA, and bot/config fingerprint; changing
the bot or model also refreshes suggestions. Only comments belonging to the
authenticated account are edited. Keep one automation instance per account and
repository; the included workflow serializes runs to avoid duplicate comments.

## Example: PR #2468

The bot discovers the actual successful deployment URL, then produces:

- `/stream/overlay?layout=6cam&theme=wolf-week` — force the changed artwork,
  independent of the current date.
- `/stream/overlay?layout=6cam&theme=auto` — check scheduled selection.
- `/stream/overlay?layout=4cam&theme=wolf-week` — check the existing fallback.

These query variants come from a small Alveus adapter that checks the PR's
overlay layouts, theme schedule, and diff. It runs only for changes to the actual
overlay or its theme/artwork files, not unrelated server files named `stream`.
It does not assume every PR supports Wolf Week or pad the three links with
unrelated pages.
Overlay previews are best viewed at 1920×1080.

For pixel rename PRs such as #2462 and #2463, the bot links to
`/institute/pixels/one/rename` and `/institute/pixels/two/rename`. The IDs are read
from that PR head's mural catalogue, after checking that the page uses the
catalogue's `getStaticPaths`. The presets UI PR #2445 links only its four changed
pages; the server-only encryption helpers PR #2452 produces no comment.

## Try locally

Requirements: Node.js 22+, Git, and the GitHub CLI (`gh auth login`). No package
dependencies or installation are needed.

```sh
pnpm test
node src/bot.mjs --pr 2463 --no-ai
```

The default is always a **dry run**. Scan all open PRs by omitting `--pr`.
`--write` explicitly creates or updates comments; `--force` regenerates an
already-current comment. To test an existing checkout without a source download,
pass `--repo-dir /path/to/checkout`; it must be at the PR head with no source
edits. Otherwise a temporary sparse checkout fetches source files and is removed
afterward. Source code, package scripts, Git hooks, and builds from PRs are never
executed; media blobs are excluded from the checkout.

Set `author` in `config.json` to a login to restrict PRs, or leave it empty for
all authors. `PR_AUTHOR` can override it locally. Set `dynamicExamples` to trusted
concrete examples when desired, for example
`{"/ambassadors/[ambassadorName]": "/ambassadors/abbott"}`. Keep config in this
bot's repository; configuration from PR branches is never loaded.

## Run in your personal GitHub repository

1. Push this directory as its own repository, with the workflow on the default
   branch. A public repository with standard Ubuntu runners has free Actions
   usage; a private repository consumes the owner's included minutes.
2. Create a personal access token whose resource owner is `alveusgg`, limited to
   `alveusgg/alveusgg`, with **Pull requests: read and write**, **Deployments:
   read**, and **Contents: read**. Organization approval or SSO authorization may
   be required by the organization's policy. The token acts as your account, so
   comments appear under your name. For a separate bot identity, use the
   GitHub App setup below instead.
3. Save that token as the bot repository's Actions secret
   `PREVIEW_GITHUB_TOKEN`. A personal repo's built-in `GITHUB_TOKEN` can read the
   public Alveus data but cannot write comments in a different repository.
4. Run **Preview links → Run workflow**, enter an open PR such as `2463`, and leave `write` false
   to inspect the generated comment in the log. Then run with `write` true to
   post that example.
5. Set the bot repository's Actions variable `PREVIEW_COMMENTS_ENABLED=true` to
   enable scheduled comments for **all existing and future open PRs**. It checks
   every ten minutes and updates only successful current previews. Until this
   variable is enabled, scheduled jobs are skipped. Remove or disable the
   variable to stop scheduled runs.

The first enabled scan backfills existing open PRs that have useful page links.
No Vercel API token is required. Preview authentication protections still apply
to reviewers; the bot does not create or publish protection-bypass tokens.

GitHub schedules can run late or occasionally be dropped; this is not instant
delivery. Public-repo schedules also disable after 60 days without repository
activity. For a continuously unattended service, run the same script on an
existing machine's timer, or use a GitHub App subscribed to `deployment_status`
for immediate delivery (an App requires installation in the Alveus repo).

## GitHub App identity

The workflow supports a private app owned by the `alveusgg` organization while
continuing to run in this public personal repository. Webhooks are disabled for
the scheduled version, so no additional server is needed.

1. Open [New GitHub App under Alveus](https://github.com/organizations/alveusgg/settings/apps/new).
   Name it **Alveus Preview Links**, or choose another available name. Set the
   homepage to this repository. Leave OAuth authorization, callback URLs, device
   flow, and setup URL unconfigured. Turn **Webhooks → Active** off.
2. Give it repository permissions **Pull requests: Read & write**,
   **Deployments: Read-only**, and **Contents: Read-only**. Metadata is included
   automatically. Choose **Only on this account** and create the app.
3. On its settings page, copy the **Client ID** into this repository's Actions
   variable `PREVIEW_APP_CLIENT_ID`. Under **Private keys**, generate a key and
   save the entire downloaded PEM file as Actions secret
   `PREVIEW_APP_PRIVATE_KEY`, including its BEGIN and END lines.
4. In the app settings sidebar, choose **Install App**, install it on `alveusgg`,
   choose **Only select repositories**, and select `alveusgg/alveusgg`.
5. Test **Preview links → Run workflow** against one open PR, selecting both
   `write` and `use_app`. The pinned GitHub-owned token action creates an
   installation token restricted to that repository and derives the bot login
   from the authenticated app slug. The app writes as `app-slug[bot]`.
6. After a successful test, set Actions variable `PREVIEW_APP_ENABLED=true`.
   Scheduled runs now use the app. After verifying the full migration, remove
   `PREVIEW_GITHUB_TOKEN` and revoke the old personal token.

If app authentication is selected but its credentials are missing or invalid,
the run fails instead of silently posting with the personal token. Until app
authentication is selected, the existing personal-token setup keeps working.
An app's own comments are updated in place. On successful app posting, the
workflow removes this personal repository owner's old comments carrying this
bot's exact marker. Other accounts' comments and ordinary discussion are left
alone. Failed legacy cleanup is retried even when the bot's links are current.
For local installation-token runs, set `GH_TOKEN`, `PREVIEW_BOT_LOGIN` (for
example `alveus-preview-links[bot]`), and optionally `PREVIEW_LEGACY_LOGIN` for
the old personal author. Without `PREVIEW_BOT_LOGIN`, local writes authenticate
as the current user via `gh api user`.

## Optional AI suggestions

Without an AI key, static tracing and the overlay adapter work at zero token
cost. To enable AI ranking and evidence-based query suggestions, add Actions
secret `OPENAI_API_KEY` and variable `OPENAI_MODEL` for a model available to your
API account that supports Responses API structured output. An optional
`OPENAI_BASE_URL` variable can select a compatible provider implementing that
API. Local runs can use `node --env-file=.env src/bot.mjs --pr 2463` after copying
`.env.example` to `.env` and filling those values.

AI is called only when generating a new comment version. Input is capped at 40
diffs, 100 route names, and six page-source excerpts. Output is capped at 2,500
tokens. No tools or execution are provided to the model. It may choose only
selected concrete paths, including source-verified mural IDs and configured
dynamic examples. Query keys must appear
in that page's `query.*` access, and values must appear as literals in the page
or its imported source. Known overlay variants are retained. API errors,
refusals, incomplete output, or invalid suggestions fall back to static links.
A valid empty result suppresses the comment instead of filling it with guesses.
Use `--force` to retry AI after a fallback. No live paid model calls are needed
for the test suite.

This is best-effort static impact analysis, not an exhaustive test plan.
Runtime-generated imports, external packages, database-driven slugs, redirects,
and server integrations can affect additional pages. The current route mapper
targets this site's Pages Router. Dynamic routes need source-verified or
configured real IDs; the bot does not invent them or query production databases. It checks source
evidence, not whether each page's backend or live data is healthy.

## Sources

The bot avatar was generated with the built-in image generation tool. The
[512px avatar](assets/bot-icon-512.png), [original image](assets/bot-icon.png),
and [generation prompt](assets/bot-icon.prompt.txt) are included for reuse.

- [GitHub deployment statuses](https://docs.github.com/en/rest/deployments/statuses)
  provide deployment state and environment URL.
- [GitHub issue-comment API](https://docs.github.com/en/rest/issues/comments)
  supports PR comments with pull-request write permission.
- [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
  documents schedule delays and automatic inactivity disabling.
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
  documents free standard runners for public repositories.
- [Official OpenAI documentation: Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)
  documents the optional Responses API integration.
