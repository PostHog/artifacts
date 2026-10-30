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
- **ID-token checks.** Each ID token is bound to the issuer (`us`/`eu`/`oauth.posthog.com`), the audience (our `client_id`), the nonce and the expiry. The signature isn't checked: the token comes straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 allows in place of a signature check.
- **Login-flow state.** State, the PKCE verifier and the nonce live in a signed, 10-minute `__Host-` cookie that is used once. After login, `next` is resolved against `PUBLIC_URL` and must stay on our origin.
- **Sessions.** A session is a signed 7-day `__Host-` cookie (HttpOnly, Secure, SameSite=Lax). Sign-out is a POST request.
- **Token purposes.** Every signed token includes its purpose (`session` / `frame` / `login`) in the MAC. That stops a public iframe grant being replayed as a session. The OAuth library's consent cookie gets a separately derived key.

### 2. Authorization
- **Owner-only actions.** Every MCP tool and the share endpoint go through `getOwnedArtifact`. Non-owners get "not found".
- **Private artifacts.** To everyone except the owner, a private artifact looks the same as a missing one: signed-in users get a 404 and signed-out visitors are sent to sign in, in both cases.
- **Public links.** A public link exposes the latest version only. Public iframe grants are re-checked on every load, so unsharing an artifact, or publishing a new version, cuts off people who already have it open.
- **Kill switch.** `revoked:<email>` in `OAUTH_KV` is checked on every web request and every MCP call:
  ```sh
  wrangler kv key put --binding OAUTH_KV --remote revoked:someone@posthog.com 1
  ```

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
- **Bounded queries.** The viewer's version list is capped.
- **No orphaned files.** If the database write fails, the uploaded R2 object is deleted.
- **Migrations.** They are idempotent (`IF NOT EXISTS`) and applied transactionally by the Worker.

## Residual risks and follow-ups

- **Phishing by insiders.** A staff member, or an agent that has been prompt-injected, can still publish a convincing phishing page *inside* the viewer, and share it. The viewer shows the author's name, and revocation is immediate. Moving content to a separate registrable domain (`CONTENT_URL`) would further separate it from posthog.com trust.
- **Leaked public links.** A public link is a bearer capability. Whoever holds it can view until the owner sets the artifact back to private.
- **Offboarding.** Revocation is manual (the KV key). Tie it to the HR or IdP offboarding process. Unrevoked sessions last at most 7 days. MCP refresh grants last up to 30 days unless revoked.
- **Rate-limit scope.** Limits are counted per Cloudflare location, not globally.
- **Rendering cost.** Markdown is rendered on every public view. That's cheap, but an attacker could amplify it with a very popular link. Add caching if traffic grows.
- **Scope.** There is a single `artifacts` scope, so any MCP grant can also delete. Split read and write scopes if third-party clients ever get access.
