import { Marked } from 'marked'
import type { AppEnv } from '../env'
import { openToken, sealToken } from '../lib/crypto'
import { getArtifact, getContent, getVersion } from '../store'

// The iframe loads once per page view, so a grant only needs to outlive that load. Short-lived
// grants also limit the damage if someone copies the content URL instead of the share link.
const FRAME_TOKEN_TTL = 60 * 10

/**
 * The same sandbox is applied by the iframe attribute and by the response's CSP. Deliberately absent:
 * allow-same-origin (content would act as the viewer's origin and, on a posthog.com subdomain, could
 * toss cookies at every posthog.com app), allow-top-navigation*, and allow-modals (prompt() phishing).
 */
export const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'

interface FrameGrant {
    id: string
    v: number
    /** Issued to a non-owner via the public link: re-checked on every load so unsharing takes effect immediately. */
    pub?: boolean
}

export const contentOrigin = (env: AppEnv) => new URL(env.CONTENT_URL || env.PUBLIC_URL).origin

/**
 * The viewer page has already decided the viewer may see this version, so it hands the iframe
 * a short-lived signed URL. The content route then needs no session, which keeps it working on
 * a separate content origin where the session cookie is never sent.
 */
export async function frameUrl(env: AppEnv, id: string, version: number, viaPublicLink: boolean): Promise<string> {
    const grant: FrameGrant = viaPublicLink ? { id, v: version, pub: true } : { id, v: version }
    const token = await sealToken(env.SESSION_SECRET, 'frame', grant, FRAME_TOKEN_TTL)
    return `${contentOrigin(env)}/c/${id}/${version}?t=${encodeURIComponent(token)}`
}

function contentHeaders(env: AppEnv): HeadersInit {
    return {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `sandbox ${SANDBOX}; frame-ancestors ${new URL(env.PUBLIC_URL).origin}`,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
    }
}

const refuse = (status: number, message: string) =>
    new Response(message, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } })

export async function serveContent(env: AppEnv, request: Request, id: string, version: number): Promise<Response> {
    const url = new URL(request.url)
    // With a dedicated content origin, never serve untrusted content from the app's own origin.
    if (env.CONTENT_URL && url.origin !== contentOrigin(env)) return refuse(404, 'Not found')
    // Content only ever renders inside the viewer's iframe, under its PostHog chrome and author line.
    // Refusing top-level loads stops bare attacker pages at artifacts.posthog.com/c/… (phishing), and
    // non-browser fetches stop our content being used as, e.g., an OAuth client metadata document.
    if (request.headers.get('Sec-Fetch-Dest') !== 'iframe') {
        return refuse(403, 'Artifacts can only be viewed on their artifact page.')
    }
    const grant = await openToken<FrameGrant>(env.SESSION_SECRET, 'frame', url.searchParams.get('t'))
    if (!grant || grant.id !== id || grant.v !== version) return refuse(403, 'This link has expired. Reload the artifact page.')
    if (grant.pub) {
        const artifact = await getArtifact(env, id)
        if (!artifact || artifact.visibility !== 'public' || artifact.latest_version !== version) {
            return refuse(404, 'This artifact is no longer shared.')
        }
    }
    const meta = await getVersion(env, id, version)
    const content = meta && (await getContent(env, meta))
    if (!meta || content == null) return refuse(404, 'Not found')
    const body = meta.format === 'markdown' ? renderMarkdown(content) : content
    return new Response(body, { headers: contentHeaders(env) })
}

const marked = new Marked({ gfm: true })

export function renderMarkdown(markdown: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>${MARKDOWN_CSS}</style></head>
<body><article>${marked.parse(markdown, { async: false })}</article></body></html>`
}

const MARKDOWN_CSS = `
:root { --text:#23251d; --muted:#4d4f46; --border:#d2d3cc; --bg:#fdfdf8; --code:#e5e7e0; --link:#f54e00; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --text:#eeefe9; --muted:#c8cac1; --border:#3b3d34; --bg:#1d1f17; --code:#2a2c24; --link:#f7a501; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.65 -apple-system, BlinkMacSystemFont, 'avenir next', avenir, 'segoe ui', 'helvetica neue', helvetica, Ubuntu, roboto, noto, arial, sans-serif; -webkit-font-smoothing: antialiased; }
article { max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; }
h1, h2, h3, h4 { line-height: 1.25; letter-spacing: -0.02em; margin: 2em 0 0.6em; }
h1 { font-size: 2.1em; margin-top: 0; } h2 { font-size: 1.5em; } h3 { font-size: 1.2em; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1.1em; }
a { color: var(--link); text-underline-offset: 2px; }
blockquote { margin-left: 0; padding: 0.2em 1em; border-left: 3px solid #eb9d2a; color: var(--muted); }
code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code); padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: var(--code); padding: 14px 16px; border-radius: 6px; overflow-x: auto; border: 1px solid var(--border); }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; }
th { background: var(--code); }
img { max-width: 100%; border-radius: 6px; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2.5em 0; }
li + li { margin-top: 0.25em; }
`
