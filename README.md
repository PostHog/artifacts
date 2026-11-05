# PostHog Artifacts

`artifacts.posthog.com` hosts content made in Claude sessions, such as reports, write-ups and HTML pages, behind unguessable share links. The design is MCP first: agents publish, update, share and delete artifacts through an MCP server. The web UI is a viewer, and its only management feature is the Share button.

## How it works

```
                       ┌───────────────── Cloudflare Worker (artifacts.posthog.com) ─────────────────┐
Claude Code ── MCP ──▶ │ /mcp            OAuth-protected MCP server (6 tools)                        │
  (OAuth, DCR/CIMD)    │ /authorize      consent page → Sign in with PostHog (@posthog.com)       │
                       │ /oauth/*        token + client registration (workers-oauth-provider)        │
Browser ─────────────▶ │ /a/:id          viewer: PostHog-branded chrome + sandboxed iframe           │
                       │ /c/:id/:v?t=…   artifact content, CSP-sandboxed, short-lived signed grant   │
                       └──────┬──────────────────┬───────────────────┬───────────────────────────────┘
                              D1 (metadata)      R2 (content)        KV (OAuth grants)
```

- **Identity:** "Sign in with PostHog" ([PostHog OAuth](https://posthog.com/docs/api/oauth), OIDC + PKCE, public client), restricted to PostHog accounts with a **verified** `@posthog.com` email. In production the `client_id` is our own Client ID Metadata Document (`/oauth/client-metadata.json`), so there is no client secret to manage. Locally, PostHog can't fetch that document, so the Worker registers a dev client through PostHog's dynamic client registration. The same identity backs web sessions and MCP tokens, so MCP clients sign in once in the browser.
- **Links:** `/a/<22 base62 chars>`, about 131 bits of randomness, so links can't be guessed or enumerated. Every response sends `noindex` and `Referrer-Policy`, so links don't leak through search engines or referrers.
- **Sharing:**
  - **Private** (the default): only the owner can view. Everyone else gets a 404, so they can't tell the artifact exists.
  - **PostHog team:** anyone signed in with a verified `@posthog.com` account sees the **latest** version. Signed-out visitors are sent to sign in, exactly as for a private artifact, so a leaked team link reveals nothing. Team links get no link-preview tags.
  - **Specific people** (`invited`): for customers. The owner lists exact emails or whole company domains (`ana@acme.com`, `@acme.com`; consumer domains like `@gmail.com` are refused). A visitor signs in with their own PostHog account, on US or EU Cloud, and is admitted only if the account's **verified** email is on the list. They get a 7-day guest cookie that opens only artifacts whose list still contains them, latest version only. The page before sign-in says nothing about the artifact. Guests are not staff and can't manage anything.
  - **Public with link:** anyone with the link sees the **latest** version.
  - Older versions are only ever visible to the owner.
  - Unsharing, removing someone from the list, or publishing a new version revokes iframe grants that are already open.
- **Versioning:** each publish with an `artifact_id` adds an immutable version. Every version is stored under its own R2 key, so concurrent publishes can't clobber each other. The owner sees a version picker and a banner when viewing an old version.
- **Untrusted content:** artifacts run in an iframe with `sandbox` (no `allow-same-origin`). The content response also carries a `Content-Security-Policy: sandbox` header, so it keeps an opaque origin even when opened top-level, and can't read cookies or call the app as the viewer. To isolate it further, set `CONTENT_URL` to a separate hostname. That host only serves `/c/*`.
- **Formats:** `html` (a page), `slides` and `markdown` (rendered with PostHog typography). A `slides` artifact is an HTML document in which each `<section>` directly inside `<body>` is a 1280×720 slide. At serve time it's wrapped in a deck viewer (`src/web/slides.ts`) with a thumbnail rail, scale-to-fit, arrow-key navigation and a Present mode, all inside the same sandboxed iframe as any other content.

### Comments

The owner can turn comments on for an artifact (off by default, so nothing already shared starts showing a discussion). A **Comments** button in the viewer bar then opens a panel with the thread and a box to add to it.

- **Who sees and writes them:** the owner, signed-in PostHog staff on team and public artifacts, and invited guests on invited ones. Anonymous link viewers see no comments and can't write any, because a public link carries no identity. Private artifacts take comments only from the owner. Everyone who can see comments sees all of them, so say so before using it on an artifact shared with both staff and customers.
- **Names:** staff show by name. Guests show as `ana (guest)` to other viewers, never their email; the owner sees the full address on hover.
- **Deleting:** authors delete their own comments and the owner deletes any. Turning comments off hides them without deleting them.
- **Limits:** plain text only, 2000 characters, 500 comments per artifact, 10 posts a minute per person. Each comment records which version was latest when it was written.
- **On a passage:** select text in the artifact and a **Comment** button appears next to the selection. Pressing it opens the panel with the passage quoted above the box. Commented passages are highlighted in the artifact; clicking one jumps to its comment, and clicking a comment's quote scrolls the passage into view (and switches slide, in a deck). Works for HTML, Markdown and slides, on the latest version while comments are on. Passages are stored as the quoted text plus up to 64 characters either side, not a DOM position, so when the author publishes a new version a comment whose text has gone shows "Can't find this text in this version" instead of pointing at the wrong place. Highlighting uses the CSS Custom Highlight API, so a browser without it still gets the button, quotes and comments but no highlight.
- **Not included:** replies, edits and notifications. Claude can read comments, with the quoted text as `on_text`, using `list_comments`.

### MCP tools

| Tool | Purpose |
|---|---|
| `publish_artifact` | Create an artifact (HTML or Markdown), or add a version with `artifact_id`. Private unless `visibility` is `"team"`, `"invited"` (with `invited_emails`) or `"public"`. |
| `list_artifacts` | Your artifacts, newest first. |
| `get_artifact` | Metadata, version history, and optionally a version's content. |
| `set_visibility` | `private`, `team`, `invited` (with `invited_emails`, which replaces the list) or `public`. |
| `update_artifact` | Rename, change the description, or turn comments on or off (`comments_enabled`). |
| `list_comments` | Comments on an artifact you own: author, email, staff or guest, version, text. |
| `delete_artifact` | Permanent delete. |

### Claude Code plugin

`plugin/` bundles the MCP server config and the `/share-artifact` skill (`plugin/skills/share-artifact/SKILL.md`). The skill tells Claude:

- what to publish from a session
- whether to use HTML or Markdown
- to scrub secrets and PII first
- to update the existing artifact rather than create duplicates

```
/plugin marketplace add PostHog/artifacts
/plugin install posthog-artifacts@posthog-artifacts
```

Without the plugin: `claude mcp add --transport http posthog-artifacts https://artifacts.posthog.com/mcp`

## Development

```sh
pnpm install
cp .dev.vars.example .dev.vars        # set SESSION_SECRET (openssl rand -hex 32)
pnpm dev                              # http://localhost:8787, dev login enabled
pnpm smoke                            # end-to-end: OAuth → MCP → viewer access rules
pnpm typecheck
```

`.dev.vars` points `PUBLIC_URL` at localhost and turns on a local-only email login. That login is refused unless `PUBLIC_URL` is localhost, so it can't be switched on in production. Local D1, R2 and KV are created automatically under `.wrangler/`.

## Deploying (Cloudflare Workers Builds, on push to `main`)

Nothing needs to be created by hand.

- **Resources:** the D1 database (`artifacts-db`), R2 bucket (`artifacts-bucket`) and KV namespace were provisioned by the first `wrangler deploy` and are pinned by ID in `wrangler.jsonc`. To stand up a fresh copy elsewhere, drop the IDs and names and Wrangler will provision new ones.
- **Schema:** the Worker applies `migrations/*.sql` itself on first use (`src/lib/migrate.ts`). Deploys are a plain `wrangler deploy` with no migration step. To change the schema, add a new numbered `.sql` file and register it in `migrate.ts`. Never edit one that has already shipped.

### Going live

1. **Connect the repo.** In the Cloudflare dashboard go to Workers & Pages → Create → Import a repository. Pick this GitHub repo with production branch `main`.
   - Worker name: `artifacts`. It must match `name` in `wrangler.jsonc`.
   - Build command: leave empty, or use `pnpm typecheck`.
   - Deploy command: the default `npx wrangler deploy`.
   - Node and pnpm versions come from `.node-version` and `packageManager`.
2. **Set the runtime secrets** under Worker → Settings → Variables & Secrets. Until `SESSION_SECRET` is set, the Worker serves a "not configured yet" page.
   - `SESSION_SECRET`: `openssl rand -hex 32`
3. **Domain.** `wrangler.jsonc` attaches `artifacts.posthog.com` as a Custom Domain on deploy. This needs the `posthog.com` zone in the same Cloudflare account. If it isn't, remove the `routes` entry, test on the `*.workers.dev` URL by setting `PUBLIC_URL` to it, then add the domain once DNS is ready.
4. Push to `main`. Every push after that deploys automatically.

Rotating `SESSION_SECRET` signs everyone out and invalidates open iframe grants. MCP tokens are unaffected.

**Revoking someone** (offboarding, incidents) takes effect immediately for both the web and MCP:

```sh
pnpm wrangler kv key put --binding OAUTH_KV --remote revoked:someone@posthog.com 1
```

See [SECURITY.md](SECURITY.md) for the threat model and the controls behind it.

## Session replay

Every page is recorded with PostHog session replay into the same project as the usage events below, including the artifact inside the viewer's iframe (`src/lib/replay.ts`).

- **The page:** `public/replay.js` asks `/replay/config` whether replay is on, then loads posthog-js. Recording starts with `startSessionRecording(true)`, so the project's sampling and triggers don't apply. Autocapture and surveys are off, but `$pageview` and `$pageleave` are captured.
- **The artifact:** content runs in a sandboxed iframe with an opaque origin, which the page's recorder can't see into. `serveContent` adds `src/web/replay-frame.ts` to the content, which runs PostHog's rrweb recorder in the frame with `recordCrossOriginIframes`. It posts its events to the page, which uploads them as part of the same replay.
- **Who:** everyone. Staff are recorded under their lowercased email, the same distinct ID as the server-side events, with no person profiles created. Invited guests and anonymous viewers are anonymous, and a guest's email is never sent. Each recording has a `viewer` property (`staff`, `guest` or `anonymous`) and, on artifact pages, `artifact_id`.
- **Masking:** form inputs are masked; artifact text is not. Authors can add `ph-no-capture` (blocked) or `ph-mask` (masked) to parts of an artifact.
- **Off switch:** `SESSION_REPLAY` in `wrangler.jsonc`. Set it to `"false"` to turn replay off, which also removes the frame script and the CSP allowances. Like analytics, local runs only record to a localhost `POSTHOG_HOST`.

## Usage analytics

Server-side events go to [project 2](https://us.posthog.com/project/2) via `posthog-node` (`src/lib/analytics.ts`), set up per [PostHog's Cloudflare Workers docs](https://posthog.com/docs/libraries/cloudflare-workers). `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` are vars in `wrangler.jsonc`; an empty token turns analytics off. Local runs only send to a localhost `POSTHOG_HOST`.

| Event | When | Key properties |
|---|---|---|
| `artifact published` | `publish_artifact` | `artifact_id`, `version`, `is_new_artifact`, `format`, `size_bytes`, `visibility` |
| `artifact visibility changed` | `set_visibility` or the Share button | `artifact_id`, `visibility`, `source` |
| `artifact details updated` | `update_artifact` | `artifact_id`, `is_title_changed`, `is_description_changed` |
| `artifact deleted` | `delete_artifact` | `artifact_id` |
| `artifact viewed` | viewer page loads | `artifact_id`, `artifact_owner`, `version`, `access` |
| `artifacts mcp tool called` | every MCP tool call | `tool`, `is_successful`, `error_code` |
| `artifacts mcp client connected` | MCP OAuth completes | `client_id`, `is_consent_remembered` |
| `artifacts user signed in` | web sign-in | |

Every event has `app = posthog-artifacts` and `is_signed_in`. Users are keyed by email with no person profiles (staff already have them in project 2). Content, titles, descriptions, notes and IPs are never sent. When querying, leave "Filter out internal and test users" off: it drops `@posthog.com` users.
