import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { User } from '../env'
import type { Artifact, Version } from '../store'

type Html = HtmlEscapedString | Promise<HtmlEscapedString>

interface LayoutOptions {
    title: string
    description?: string
    body: Html
    bodyClass?: string
    /** Open Graph tags are only emitted for content that is safe to unfurl (public artifacts, landing page). */
    og?: { title: string; description?: string; url: string }
}

export function layout({ title, description, body, bodyClass, og }: LayoutOptions) {
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>${title}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
${og
    ? html`<meta property="og:site_name" content="PostHog Artifacts">
<meta property="og:title" content="${og.title}">
${og.description ? html`<meta property="og:description" content="${og.description}">` : ''}
<meta property="og:url" content="${og.url}">
<meta property="og:type" content="article">`
    : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="${bodyClass ?? ''}">
${body}
</body>
</html>`
}

const logo = html`<img class="logo-light" src="/logo.svg" alt="PostHog"><img class="logo-dark" src="/logo-white.svg" alt="PostHog">`

function initials(user: User) {
    return user.name
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
}

function userMenu(user: User | null, next: string) {
    if (!user) return html`<a class="ghost" href="/login?next=${encodeURIComponent(next)}">Sign in</a>`
    return html`<a class="avatar" href="/" title="${user.name} (${user.email}) — your artifacts">${initials(user)}</a>`
}

export function appBar({ user, next, center, actions }: { user: User | null; next: string; center?: Html; actions?: Html }) {
    return html`<header class="bar">
  <a class="brand" href="/">${logo}<span class="product">Artifacts</span></a>
  <span class="sep"></span>
  <div class="title">${center ?? ''}</div>
  <div class="actions">${actions ?? ''}${userMenu(user, next)}</div>
</header>`
}

export function relativeTime(ms: number): string {
    const seconds = Math.round((Date.now() - ms) / 1000)
    const units: [number, Intl.RelativeTimeFormatUnit][] = [
        [60, 'second'],
        [60, 'minute'],
        [24, 'hour'],
        [30, 'day'],
        [12, 'month'],
        [Infinity, 'year'],
    ]
    let value = seconds
    for (const [size, unit] of units) {
        if (Math.abs(value) < size) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-value, unit)
        value = Math.round(value / size)
    }
    return ''
}

const lockIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>'
)
const globeIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
)
const expandIcon = raw(
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
)

export function visibilityPill(visibility: Artifact['visibility']) {
    return visibility === 'public'
        ? html`<span class="pill public" data-visibility-pill>${globeIcon} Public</span>`
        : html`<span class="pill" data-visibility-pill>${lockIcon} Private</span>`
}

interface ViewerOptions {
    user: User | null
    artifact: Artifact
    versions: Version[]
    version: Version
    owner: boolean
    frameSrc: string
    shareUrl: string
}

export function viewerPage({ user, artifact, versions, version, owner, frameSrc, shareUrl }: ViewerOptions) {
    const isLatest = version.version === artifact.latest_version
    const author = artifact.owner_name ?? artifact.owner_email

    const versionPicker = owner
        ? html`<details class="pop" data-close-outside>
    <summary class="ghost" title="Version history">v${version.version} <span class="muted">of ${artifact.latest_version}</span> ▾</summary>
    <div class="panel left">
      <h3>Version history</h3>
      <p class="hint">Only the latest version is visible to people you share with.</p>
      ${versions.map(
          (v) => html`<a class="version" href="/a/${artifact.id}${v.version === artifact.latest_version ? '' : `?v=${v.version}`}" aria-current="${v.version === version.version}">
        <div class="row"><strong>Version ${v.version}${v.version === artifact.latest_version ? ' · latest' : ''}</strong><span class="muted">${relativeTime(v.created_at)}</span></div>
        ${v.note ? html`<div class="note">${v.note}</div>` : ''}
      </a>`
      )}
    </div>
  </details>`
        : html`<span class="pill hide-sm">v${version.version}</span>`

    const share = owner
        ? html`<details class="pop" data-close-outside>
    <summary class="btn"><span>Share</span></summary>
    <div class="panel right">
      <h3>Share “${artifact.title}”</h3>
      <form data-share-form data-artifact="${artifact.id}">
        <label class="choice">
          <input type="radio" name="visibility" value="private" ${artifact.visibility === 'private' ? 'checked' : ''}>
          <span><strong>Private</strong><small>Only you can view this artifact.</small></span>
        </label>
        <label class="choice">
          <input type="radio" name="visibility" value="public" ${artifact.visibility === 'public' ? 'checked' : ''}>
          <span><strong>Anyone with the link</strong><small>Anyone with the link can view the latest version. Links can't be guessed.</small></span>
        </label>
      </form>
      <div class="copy">
        <input readonly value="${shareUrl}" aria-label="Share link" data-share-link ${artifact.visibility === 'private' ? 'disabled' : ''}>
        <button class="btn secondary" type="button" data-copy ${artifact.visibility === 'private' ? 'disabled' : ''}><span>Copy</span></button>
      </div>
    </div>
  </details>`
        : ''

    const center = html`<h1 title="${artifact.title}">${artifact.title}</h1>
  ${versionPicker}
  ${owner ? visibilityPill(artifact.visibility) : ''}
  <span class="meta">${owner ? 'Updated' : 'By ' + author + ' ·'} ${relativeTime(isLatest ? artifact.updated_at : version.created_at)}</span>`

    const actions = html`<a class="ghost hide-sm" href="${frameSrc}" target="_blank" rel="noopener noreferrer" title="Open in a new tab">${expandIcon}</a>
  ${share}`

    return layout({
        title: `${artifact.title} · PostHog Artifacts`,
        description: artifact.description ?? undefined,
        og:
            artifact.visibility === 'public'
                ? { title: artifact.title, description: artifact.description ?? `Shared by ${author}`, url: shareUrl }
                : undefined,
        body: html`<div class="viewer">
${appBar({ user, next: `/a/${artifact.id}`, center, actions })}
${!isLatest
    ? html`<div class="banner">You're viewing version ${version.version}. People you share with only see the latest. <a href="/a/${artifact.id}">View latest (v${artifact.latest_version})</a></div>`
    : ''}
<iframe src="${frameSrc}" title="${artifact.title}" sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads" allow="clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script src="/viewer.js" defer></script>`,
    })
}

export function homePage({ user, artifacts, publicUrl }: { user: User | null; artifacts: Artifact[]; publicUrl: string }) {
    const setup = html`<div class="card">
  <strong>Connect Claude Code</strong>
  <p class="small muted" style="margin:4px 0 0">Install the plugin to get the MCP server and the <code>/share-artifact</code> skill:</p>
  <pre class="snippet">/plugin marketplace add PostHog/artifacts
/plugin install posthog-artifacts@posthog-artifacts</pre>
  <p class="small muted" style="margin:12px 0 0">Or just add the MCP server to any MCP client:</p>
  <pre class="snippet">claude mcp add --transport http posthog-artifacts ${publicUrl}/mcp</pre>
</div>`

    if (!user) {
        return layout({
            title: 'PostHog Artifacts',
            og: { title: 'PostHog Artifacts', description: 'Things we made with Claude, shared.', url: publicUrl },
            body: html`${appBar({ user, next: '/' })}
<main class="page">
  <h1>Artifacts</h1>
  <p class="lede">A place for the reports, write-ups and pages we make with Claude. Publish from any Claude session, share with a link.</p>
  <div class="row-actions" style="margin-bottom:32px"><a class="btn lg" href="/login"><span>Sign in with Google</span></a><span class="small muted">PostHog staff only</span></div>
  ${setup}
</main>`,
        })
    }

    return layout({
        title: 'Your artifacts · PostHog Artifacts',
        body: html`${appBar({ user, next: '/', actions: html`<a class="ghost" href="/logout">Sign out</a>` })}
<main class="page">
  <h1>Your artifacts</h1>
  <p class="lede">Everything you've published. Ask Claude to publish or update one, or use <code>/share-artifact</code>.</p>
  <div class="card" style="padding:0">
  ${artifacts.length
      ? html`<table class="list">
    <thead><tr><th>Title</th><th class="hide-sm">Access</th><th class="num hide-sm">Version</th><th class="num">Updated</th></tr></thead>
    <tbody>
    ${artifacts.map(
        (a) => html`<tr>
      <td><a href="/a/${a.id}">${a.title}</a>${a.description ? html`<div class="small muted">${a.description}</div>` : ''}</td>
      <td class="hide-sm">${visibilityPill(a.visibility)}</td>
      <td class="num hide-sm">v${a.latest_version}</td>
      <td class="num">${relativeTime(a.updated_at)}</td>
    </tr>`
    )}
    </tbody>
  </table>`
      : html`<div class="empty">Nothing here yet. In Claude Code, try <code>/share-artifact</code>.</div>`}
  </div>
  <h2>Setup</h2>
  ${setup}
</main>`,
    })
}

export function loginPage({ next, error, google, dev }: { next: string; error?: string; google: boolean; dev: boolean }) {
    return layout({
        title: 'Sign in · PostHog Artifacts',
        body: html`${appBar({ user: null, next })}
<main class="page narrow">
  <h1>Sign in</h1>
  <p class="lede">Use your PostHog Google account.</p>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <div class="stack">
    ${google
        ? html`<a class="btn lg" href="/auth/google?next=${encodeURIComponent(next)}"><span>Continue with Google</span></a>`
        : html`<p class="muted small">Google sign-in isn't configured (set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).</p>`}
    ${dev
        ? html`<form class="card stack" method="post" action="/login/dev">
      <strong>Local dev login</strong>
      <input type="hidden" name="next" value="${next}">
      <input class="text" name="email" type="email" placeholder="you@posthog.com" required>
      <input class="text" name="name" placeholder="Your name">
      <button class="btn" type="submit"><span>Sign in (dev only)</span></button>
    </form>`
        : ''}
  </div>
</main>`,
    })
}

export function consentPage({ user, details, handle }: { user: User; details: ConsentDescription; handle: string }) {
    return layout({
        title: 'Connect · PostHog Artifacts',
        body: html`${appBar({ user, next: '/' })}
<main class="page narrow">
  <h1>Connect ${details.clientName}?</h1>
  <p class="lede">${details.clientDomain
      ? html`Published by <strong>${details.clientDomain}</strong>.`
      : 'This app registered itself; its name is not verified.'}
  It will be able to publish, update, share and delete artifacts as <strong>${user.email}</strong>.</p>
  <div class="card stack">
    <div class="small">Access will be sent to <strong>${details.redirectHost}</strong>.</div>
    ${details.redirectIsLoopback
        ? html`<div class="small"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it (for example Claude Code).</div>`
        : ''}
    <form method="post" action="/authorize" class="row-actions">
      <input type="hidden" name="handle" value="${handle}">
      <input type="hidden" name="scope" value="artifacts">
      <button class="btn" name="decision" value="approve"><span>Allow</span></button>
      <button class="btn secondary" name="decision" value="deny"><span>Deny</span></button>
    </form>
  </div>
</main>`,
    })
}

export function messagePage({ user, title, message, status }: { user: User | null; title: string; message: string; status?: number }) {
    return layout({
        title: `${title} · PostHog Artifacts`,
        body: html`${appBar({ user, next: '/' })}
<main class="page narrow">
  <h1>${title}</h1>
  <p class="lede">${message}</p>
  ${status === 404 && !user ? html`<a class="btn" href="/login"><span>Sign in</span></a>` : html`<a class="btn secondary" href="/"><span>Back to artifacts</span></a>`}
</main>`,
    })
}
