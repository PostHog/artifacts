# Threat model

This document covers artifacts.posthog.com: one Cloudflare Worker that does three jobs. It is the MCP server, it is the OAuth authorization server for MCP clients, and it is the artifact viewer. It was last reviewed on 2026-10-30. That review combined an internal pass with an independent adversarial review. Every fix below has a regression check in `scripts/smoke.mjs`.

## Assets

- **Private artifact content.** Internal analyses that can include customer data.
- **The share-link capability.** Holding a 131-bit ID for a public artifact grants access to it.
- **User sessions and MCP grants.** Either one lets the holder publish, read, share or delete artifacts as that user.
- **The posthog.com origin's reputation.** Content hosted on it is trusted by staff and customers.

## Actors

| Actor | Can | Wants |
|---|---|---|
| Anonymous internet | Reach every route, register OAuth clients, hold public links | Read private artifacts, phish users, abuse resources |
| Artifact content (LLM output, possibly prompt-injected, or a malicious author) | Run arbitrary HTML/JS in the viewer | Escape the sandbox, steal tokens, phish the viewer |
| Malicious MCP client | Register, then send a staffer to `/authorize` | Obtain a staffer's MCP token |
| Non-owner staff | Sign in | Read other people's private artifacts or old versions |
| Departed staff, or someone holding a stolen cookie/token | Replay credentials | Keep access |

## Trust boundaries and controls

### 1. Identity
- **Who can sign in.** "Sign in with PostHog" uses OIDC with PKCE as a public client. Access requires `email_verified === true` *and* an email exactly `@posthog.com`. The verified check is required because anyone can sign up to PostHog with an unverified address.
- **ID-token checks.** Each ID token is bound to the issuer (exactly `https://us.posthog.com`; EU Cloud and the region-agnostic `oauth.posthog.com` are not accepted), the audience (our `client_id`), the nonce and the expiry. The signature isn't checked: the token comes straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 allows in place of a signature check.
- **Login-flow state.** State, the PKCE verifier and the nonce live in a signed, 10-minute `__Host-` cookie that is used once. After login, `next` is resolved against `PUBLIC_URL` and must stay on our origin.
- **Sessions.** A session is a signed 7-day `__Host-` cookie (HttpOnly, Secure, SameSite=Lax). Sign-out is a POST request.
- **Token purposes.** Every signed token includes its purpose (`session` / `frame` / `login`) in the MAC. That stops a public iframe grant being replayed as a session. The OAuth library's consent cookie gets a separately derived key.

### 2. Authorization
- **Owner-only actions.** Every MCP tool and the share endpoint go through `getOwnedArtifact`. Non-owners get "not found".
- **Private artifacts.** To everyone except the owner, a private artifact looks the same as a missing one: signed-in users get a 404 and signed-out visitors are sent to sign in, in both cases.
- **Team artifacts.** Viewable by any signed-in user, which means a verified `@posthog.com` account that hasn't been revoked. To signed-out visitors they look exactly like private ones (a sign-in redirect), and they carry no Open Graph tags, so unfurlers learn nothing. Like public links, team access covers the latest version only, and team iframe grants are re-checked on every load, so going back to private, or publishing a new version, cuts off open viewers. A revoked user's already-issued team grant lasts until it expires: 10 minutes for an iframe grant, an hour for an agent handover link.
- **Invited artifacts (customers).** The visitor signs in with their own PostHog account through the same OIDC + PKCE flow as staff, but in a guest mode: any account with a **verified** email is accepted, and the artifact's allowlist decides access. The result is a `guest` cookie (`__Host-`, HttpOnly, 7 days), a different token purpose from a session, so it cannot be replayed as one and `getUser` ignores it. It opens only artifacts whose allowlist still matches the address, checked on every view.
  - **Gate.** Anyone who isn't the owner, signed in or not, sees the same page with the sign-in buttons. It shows no title, author or other artifact detail and is never unfurled. Having a PostHog account, or being PostHog staff, earns nothing without being on the list.
  - **Issuers.** Staff logins are still accepted from US Cloud only. Guest logins may go to US Cloud or EU Cloud (`POSTHOG_EU_OAUTH_HOST`). The host is fixed in the signed login cookie at the start, and the ID token's issuer, audience, nonce and expiry are checked against it.
  - **Trust.** Identity is whatever PostHog asserts: we require `email_verified === true` and rely on PostHog's own verification of the address.
  - **Allowlist.** Exact addresses or `@domain` (exact domain, not subdomains or lookalikes), at most 50 entries, consumer mail domains refused. A domain entry admits everyone with a verified address at that domain, so use it only for companies you'd share with entirely.
  - **Revocation.** Removing an entry, unsharing or publishing a new version cuts off open iframe grants on their next load (grants carry the address and are re-checked, like public and team grants). A guest's cookie lasts 7 days but opens nothing once they're off the list. `revoked:<email>` also blocks a guest address.
- **Comments.** Off per artifact until the owner turns them on. Who may write mirrors who may view, minus anonymous visitors: the owner; signed-in staff on team and public artifacts; invited guests on invited ones, with the allowlist re-checked on every post and delete, not taken from the cookie. Anonymous link viewers get no panel and every comment route answers 404 for them. All comment routes are same-origin POSTs. Bodies are plain text, capped at 2000 characters and 500 per artifact, and only ever rendered escaped. Posting is rate limited per person (`COMMENT_LIMITER`). Authors may delete their own comments (matched on kind and address, so a staff address can't delete a guest's) and the owner may delete any. `list_comments` tells the model that comment text is other people's words, not instructions.
  - **Comments on a passage.** The artifact runs in a sandbox the viewer can't read, so a short script (`src/web/annotate.ts`) is added to the artifact's own response and runs in that same opaque-origin iframe. It is only added when the signed frame grant says the viewer can see comments, and the content route re-checks that comments are still on and the version is still the latest, so turning comments off or publishing again removes it. It talks to the viewer only by `postMessage`, targeted at the viewer's origin; the viewer accepts messages only from that iframe's window, treats everything as untrusted text, and uses it only to fill a form the person still has to submit or to toggle a class. The artifact's own code shares the iframe with the script and can send the same messages, so a hostile artifact can at worst prefill a comment box with text it chose or mark comments as not found. The viewer sends the iframe only the quoted passages and comment ids, never comment bodies or authors. Quotes are cleaned of control characters, capped at 500 characters (context 64), and only ever rendered escaped, including inside attributes. The script adds no DOM to the artifact apart from a closed shadow-root button on the document element.
- **View counter.** Every view by someone other than the owner is recorded in D1 (`artifact_views`): staff by name and email, invited guests by email, signed-out visitors only by their random analytics cookie ID. Only the owner sees it, rendered server-side into their own viewer page; there's no endpoint and no MCP tool for it, and non-owners never receive the data. Rows are deleted with the artifact. Staff and guest rows are bounded by who can sign in, but anyone with a public link can send signed-out views with any cookie, so that path is bounded twice: recording is rate-limited per IP and artifact (`VIEW_LIMITER`, 20 a minute; past it the page still loads and the view isn't counted), and an artifact keeps at most `ANON_VIEW_CAP` (10,000) signed-out rows, after which new browsers' views go to one `anon:overflow` row. The cap check and the write are one SQL statement. Viewers aren't told their visit is shown to the author, so treat an artifact's view list like its comment thread: visible to whoever owns it.
  - **Residual risk.** A thread is visible to every viewer who can comment, so an internal remark on an artifact that is also shared with customers is visible to them. The panel says who can see comments, but the owner is the control.
- **Public links.** A public link exposes the latest version only. Public iframe grants are re-checked on every load, so unsharing an artifact, or publishing a new version, cuts off people who already have it open.
- **Kill switch.** `revoked:<email>` in `OAUTH_KV` is checked on every web request and every MCP call:
  ```sh
  wrangler kv key put --binding OAUTH_KV --remote revoked:someone@posthog.com 1
  ```
  It's also checked on every load of an owner's content links: their iframe grants and the agent handover links they made (valid for an hour, and possibly pasted into an agent or elsewhere). Revoking an owner cuts those off straight away. Links issued to other viewers of a team or public artifact are still checked against the artifact, not the viewer, so a revoked staff member's team link lasts until it expires: 10 minutes for an iframe grant, an hour for a handover link.

### 3. Untrusted artifact content
- **Sandbox.** Content renders in `<iframe sandbox>` and also carries `Content-Security-Policy: sandbox`. Either way the content gets an opaque origin, so it can't read our cookies or call our API as the viewer.
- **Sandbox flags we never grant:** `allow-same-origin`, `allow-top-navigation*` or `allow-modals`.
- **Viewer-only rendering.** `/c/*` only serves requests with `Sec-Fetch-Dest: iframe`. Content can't be opened as a bare page on our domain (phishing) or fetched as a document, for example as an OAuth client metadata document. It is always shown under PostHog chrome that names the author.
- **Frame grants.** These are signed and expire after 10 minutes.
- **No tab-nabbing.** The viewer sends `Cross-Origin-Opener-Policy: same-origin`, so popups the content opens can't navigate the viewer tab.
- **Optional content host.** `CONTENT_URL` must be a *different registrable domain*, such as `posthogusercontent.com`. On a `posthog.com` subdomain, content could set cookies for every posthog.com app. When `CONTENT_URL` is set, content is never served from the app origin.

### 4. MCP OAuth (we are the authorization server)
- **Where tokens can go.** MCP clients may only send tokens to loopback addresses (Claude Code and other local clients) or to hosts in `MCP_REDIRECT_HOSTS` (default `claude.ai,claude.com`). This is enforced at both registration and `/authorize`.
- **No self-hosted client IDs.** Client metadata documents hosted on our own domains are refused, so the consent page can never say "Published by artifacts.posthog.com" for a client that an artifact author controls.
- **Consent page protections.** The consent page is bound to the browser, single-use and impossible to frame (library helpers). The consent POST must be same-origin. Remembered consent is per user, client, redirect URI and resource.
- **Registration rate limit.** Dynamic client registration is limited to 10 per minute per IP.

### 5. Web hardening
- **Our own pages** send:
  - a strict CSP (`script-src 'self'`, no inline script or styles, `frame-ancestors 'none'`)
  - `X-Frame-Options: DENY`, HSTS, `nosniff` and `noindex`
  - `Referrer-Policy: same-origin`, with `no-referrer` on content
- **Cross-site POSTs.** State-changing POSTs check `Sec-Fetch-Site` (falling back to `Origin`) on top of the SameSite cookies.
- **Login errors.** These travel as fixed codes, so nobody can put their own text on the sign-in page.
- **Escaping.** Templates use hono/html auto-escaping, and `raw()` is used only for static SVGs.

### 6. Abuse and robustness
- **Publish limits.** 5 MB per version and 30 publishes per minute per user. The MCP body limit (about 10 MB, to allow for JSON escaping) is enforced before the SDK sees the request, which works around an `agents` bug that applied a 4 MB default.
- **Bounded queries.** The viewer's version list is capped. The owner's view counter reads at most 200 named viewers, and the rows it totals are bounded by the view-counter caps above.
- **No orphaned files.** If the database write fails, the uploaded R2 object is deleted.
- **Migrations.** They are idempotent (`IF NOT EXISTS`) and applied transactionally by the Worker.

## Residual risks and follow-ups

- **Phishing by insiders.** A staff member, or an agent that has been prompt-injected, can still publish a convincing phishing page *inside* the viewer, and share it. The viewer shows the author's name, and revocation is immediate. Moving content to a separate registrable domain (`CONTENT_URL`) would further separate it from posthog.com trust.
- **Leaked public links.** A public link is a bearer capability. Whoever holds it can view until the owner sets the artifact back to private.
- **Offboarding.** Revocation is manual (the KV key). Tie it to the HR or IdP offboarding process. Unrevoked sessions last at most 7 days. MCP refresh grants last up to 30 days unless revoked.
- **Rate-limit scope.** Limits are counted per Cloudflare location, not globally.
- **Rendering cost.** Markdown is rendered on every public view. That's cheap, but an attacker could amplify it with a very popular link. Add caching if traffic grows.
- **Scope.** There is a single `artifacts` scope, so any MCP grant can also delete. Split read and write scopes if third-party clients ever get access.
