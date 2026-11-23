import type { AppEnv } from '../env'

/**
 * Where MCP OAuth clients may receive tokens. Loopback covers local clients (Claude Code, Cursor,
 * MCP Inspector); MCP_REDIRECT_HOSTS lists hosted client domains (claude.ai connectors by default);
 * MCP_REDIRECT_URIS lists exact https callback URIs (origin + pathname, no query) such as Google
 * Antigravity's https://antigravity.google/oauth-callback.
 *
 * Without this, anyone can register a client (DCR or CIMD) that sends tokens to their own server and
 * phish a staffer into clicking Allow: the consent page warns, but a policy beats a warning.
 */
function allowedRedirectHosts(env: AppEnv): string[] {
    return (env.MCP_REDIRECT_HOSTS || 'claude.ai,claude.com')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean)
}

function allowedRedirectUris(env: AppEnv): string[] {
    const out: string[] = []
    for (const raw of (env.MCP_REDIRECT_URIS || '').split(',')) {
        const trimmed = raw.trim()
        if (!trimmed) continue
        try {
            const url = new URL(trimmed)
            if (url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash) {
                out.push(url.origin + url.pathname)
            }
        } catch {
            // Ignore malformed entries rather than widening the allowlist.
        }
    }
    return out
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isAllowedRedirectUri(env: AppEnv, uri: string): boolean {
    let url: URL
    try {
        url = new URL(uri)
    } catch {
        return false
    }
    if (url.username || url.password || url.hash) return false
    if (LOOPBACK.has(url.hostname)) return url.protocol === 'http:' || url.protocol === 'https:'
    if (url.protocol === 'https:' && !url.search && allowedRedirectUris(env).includes(url.origin + url.pathname)) return true
    return url.protocol === 'https:' && allowedRedirectHosts(env).includes(url.hostname)
}

/**
 * A Client ID Metadata Document hosted on our own hosts would make the consent page say
 * "Published by artifacts.posthog.com" for a client an artifact author controls.
 */
export function isSelfHostedClientId(env: AppEnv, clientId: string): boolean {
    try {
        const host = new URL(clientId).host
        return [env.PUBLIC_URL, env.CONTENT_URL].filter(Boolean).some((origin) => new URL(origin).host === host)
    } catch {
        return false
    }
}

/** CSP for our own pages (not artifact content, which carries its own sandbox CSP). */
export function pageCsp(env: AppEnv, contentOrigin: string): string {
    // form-action also governs the redirect after the consent form posts, so it must include where
    // MCP clients receive their authorization code.
    const formTargets = [
        "'self'",
        'http://localhost:*',
        'http://127.0.0.1:*',
        'http://[::1]:*',
        ...allowedRedirectHosts(env).map((h) => `https://${h}`),
        ...allowedRedirectUris(env),
    ]
    return [
        "default-src 'none'",
        "script-src 'self'",
        // RoundHog is linked from the brandbook (see ROUNDHOG_STYLESHEET, pinned with SRI).
        "style-src 'self' https://brand.posthog.com",
        "font-src https://brand.posthog.com",
        "img-src 'self' data:",
        "connect-src 'self'",
        `frame-src ${contentOrigin}`,
        `form-action ${formTargets.join(' ')}`,
        "base-uri 'none'",
        "frame-ancestors 'none'",
    ].join('; ')
}
