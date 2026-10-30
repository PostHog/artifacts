import { Marked } from 'marked'
import type { AppEnv } from '../env'
import { openToken, sealToken } from '../lib/crypto'
import { getArtifact, getContent, getVersion } from '../store'

const FRAME_TOKEN_TTL = 60 * 60 * 6

interface FrameGrant {
    id: string
    v: number
    /** Issued to a non-owner via the public link: re-checked on every load so unsharing takes effect immediately. */
    pub?: boolean
}

const contentOrigin = (env: AppEnv) => env.CONTENT_URL || env.PUBLIC_URL

/**
 * The viewer page has already decided the viewer may see this version, so it hands the iframe
 * a short-lived signed URL. The content route then needs no session, which keeps it working on
 * a separate content origin where the session cookie is never sent.
 */
export async function frameUrl(env: AppEnv, id: string, version: number, viaPublicLink: boolean): Promise<string> {
    const grant: FrameGrant = viaPublicLink ? { id, v: version, pub: true } : { id, v: version }
    const token = await sealToken(env.SESSION_SECRET, grant, FRAME_TOKEN_TTL)
    return `${contentOrigin(env)}/c/${id}/${version}?t=${encodeURIComponent(token)}`
}

/**
 * Untrusted artifact content. `sandbox` without allow-same-origin gives it an opaque origin even
 * when opened top-level, so it can't read the viewer's cookies or call the API as the user.
 */
function contentHeaders(env: AppEnv): HeadersInit {
    const separateOrigin = !!env.CONTENT_URL && new URL(env.CONTENT_URL).origin !== new URL(env.PUBLIC_URL).origin
    const sandbox = `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-modals allow-downloads${separateOrigin ? ' allow-same-origin' : ''}`
    return {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `${sandbox}; frame-ancestors ${new URL(env.PUBLIC_URL).origin}`,
        'Cache-Control': 'private, no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Robots-Tag': 'noindex, nofollow',
        'X-Content-Type-Options': 'nosniff',
    }
}

export async function serveContent(env: AppEnv, request: Request, id: string, version: number): Promise<Response> {
    const grant = await openToken<FrameGrant>(env.SESSION_SECRET, new URL(request.url).searchParams.get('t'))
    if (!grant || grant.id !== id || grant.v !== version) {
        return new Response('This link has expired. Reload the artifact page.', { status: 403, headers: { 'Content-Type': 'text/plain' } })
    }
    if (grant.pub) {
        const artifact = await getArtifact(env, id)
        if (!artifact || artifact.visibility !== 'public' || artifact.latest_version !== version) {
            return new Response('This artifact is no longer shared.', { status: 404, headers: { 'Content-Type': 'text/plain' } })
        }
    }
    const meta = await getVersion(env, id, version)
    const content = meta && (await getContent(env, meta))
    if (!meta || content == null) return new Response('Not found', { status: 404 })
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
