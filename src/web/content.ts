import { Marked } from 'marked'
import type { AppEnv } from '../env'
import { openToken, sealToken } from '../lib/crypto'
import { isRevoked } from '../lib/session'
import { injectAnnotator } from './annotate'
import { renderSlides } from './slides'
import { getArtifact, getContent, getVersion, isInvited } from '../store'

// The iframe loads once per page view, so a grant only needs to outlive that load. Short-lived
// grants also limit the damage if someone copies the content URL instead of the share link.
const FRAME_TOKEN_TTL = 60 * 10

/**
 * The same sandbox is applied by the iframe attribute and by the response's CSP. Deliberately absent:
 * allow-same-origin (content would act as the viewer's origin and, on a posthog.com subdomain, could
 * toss cookies at every posthog.com app), allow-top-navigation*, and allow-modals (prompt() phishing).
 */
export const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-forms allow-downloads'

/** What the viewer page decided: which version, and on what grounds. Shared by iframe and agent grants. */
interface AccessGrant {
    id: string
    v: number
    /** Issued to a non-owner via the public link: re-checked on every load so unsharing takes effect immediately. */
    pub?: boolean
    /** Issued to a non-owner staff member via team sharing: re-checked on every load, like pub. */
    team?: boolean
    /** Issued to an invited viewer (their email): re-checked against the allowlist on every load. */
    guest?: string
}

interface FrameGrant extends AccessGrant {
    /** The viewer can see comments on this (latest) version: add the annotator script to the content. */
    ann?: boolean
}

/** How the viewer got access: as the owner, or as someone the artifact is shared with. */
export type FrameAccess = 'owner' | 'team' | 'invited' | 'public'

export const contentOrigin = (env: AppEnv) => new URL(env.CONTENT_URL || env.PUBLIC_URL).origin

/**
 * The viewer page has already decided the viewer may see this version, so it hands the iframe
 * a short-lived signed URL. The content route then needs no session, which keeps it working on
 * a separate content origin where the session cookie is never sent.
 */
/**
 * Re-checks a grant against the artifact as it is now. No session reaches the routes that use grants, so the
 * grant carries what was decided. Non-owners lose access on the next load when the artifact is unshared, they're
 * removed from the list, or a newer version is published. An owner grant carries nothing but is cut off when the
 * owner is revoked (the kill switch in session.ts), so links they handed over stop working straight away.
 */
async function stillShared(env: AppEnv, grant: AccessGrant): Promise<boolean> {
    const artifact = await getArtifact(env, grant.id)
    if (!artifact) return false
    if (!grant.pub && !grant.team && !grant.guest) return !(await isRevoked(env, artifact.owner_email))
    if (artifact.latest_version !== grant.v) return false
    // A team grant went to signed-in staff, who can still view if the artifact has since gone public.
    if (grant.pub) return artifact.visibility === 'public'
    if (grant.team) return artifact.visibility === 'team' || artifact.visibility === 'public'
    return artifact.visibility === 'invited' && (await isInvited(env, grant.id, grant.guest!)) && !(await isRevoked(env, grant.guest!))
}

function accessGrant(id: string, version: number, access: FrameAccess, guestEmail?: string): AccessGrant {
    return {
        id,
        v: version,
        ...(access === 'public' && { pub: true }),
        ...(access === 'team' && { team: true }),
        ...(access === 'invited' && guestEmail && { guest: guestEmail }),
    }
}

export async function frameUrl(env: AppEnv, id: string, version: number, access: FrameAccess, guestEmail?: string, annotate = false): Promise<string> {
    const grant: FrameGrant = { ...accessGrant(id, version, access, guestEmail), ...(annotate && { ann: true }) }
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
    if (!(await stillShared(env, grant))) return refuse(404, 'This artifact is no longer shared.')
    const meta = await getVersion(env, id, version)
    // A quiz is rendered by the viewer page itself, never in an iframe: this route would serve its answer key.
    if (meta?.format === 'quiz') return refuse(404, 'Not found')
    const content = meta && (await getContent(env, meta))
    if (!meta || content == null) return refuse(404, 'Not found')
    const rendered = meta.format === 'markdown' ? renderMarkdown(content) : meta.format === 'slides' ? renderSlides(content) : content
    // Re-checked here, so turning comments off, or publishing a newer version, takes the script out on the next load.
    let annotate = false
    if (grant.ann) {
        const artifact = await getArtifact(env, id)
        annotate = !!artifact?.comments_enabled && artifact.latest_version === version
    }
    return new Response(annotate ? injectAnnotator(rendered, new URL(env.PUBLIC_URL).origin) : rendered, { headers: contentHeaders(env) })
}

// --- Agent handover ----------------------------------------------------------------

// Long enough to click, read the prompt and press Enter in Claude Code or Codex, short enough that a prompt
// pasted somewhere it shouldn't be stops working soon.
export const AGENT_TOKEN_TTL = 60 * 60

export type AgentTarget = 'claude_code' | 'codex' | 'copy'

interface AgentGrant extends AccessGrant {
    /** Where the prompt was handed to, and who handed it over (analytics distinct_id and viewer_type). */
    to: AgentTarget
    who: string
    vt: string
}

/**
 * A short-lived URL an agent can download one version from with curl, minted for someone the viewer page has
 * just let in. It carries the same grant as the iframe, and is re-checked the same way on every fetch.
 */
export async function agentContentUrl(
    env: AppEnv,
    id: string,
    version: number,
    access: FrameAccess,
    guestEmail: string | undefined,
    handover: { to: AgentTarget; who: string; viewerType: string }
): Promise<string> {
    const grant: AgentGrant = { ...accessGrant(id, version, access, guestEmail), to: handover.to, who: handover.who, vt: handover.viewerType }
    const token = await sealToken(env.SESSION_SECRET, 'agent', grant, AGENT_TOKEN_TTL)
    return `${new URL(env.PUBLIC_URL).origin}/a/${id}/agent?t=${encodeURIComponent(token)}`
}

export type AgentFetch = { ok: true; response: Response; grant: AgentGrant; format: string } | { ok: false; response: Response }

/**
 * Serves the raw source (Markdown or HTML) as plain text. It's for agents, not browsers: text/plain with
 * nosniff and a sandbox CSP means opening the link in a browser shows the source, never runs it.
 */
export async function serveAgentContent(env: AppEnv, request: Request, id: string): Promise<AgentFetch> {
    const grant = await openToken<AgentGrant>(env.SESSION_SECRET, 'agent', new URL(request.url).searchParams.get('t'))
    if (!grant || grant.id !== id) return { ok: false, response: refuse(403, 'This link has expired. Open the artifact page and hand it over again.') }
    if (!(await stillShared(env, grant))) return { ok: false, response: refuse(404, 'This artifact is no longer shared.') }
    const meta = await getVersion(env, id, grant.v)
    const content = meta && (await getContent(env, meta))
    if (!meta || content == null) return { ok: false, response: refuse(404, 'Not found') }
    // A quiz's source is its answer key, so only the owner's grants may download it.
    if (meta.format === 'quiz' && (grant.pub || grant.team || grant.guest)) return { ok: false, response: refuse(404, 'Not found') }
    const filename = `${id}-v${meta.version}.${meta.format === 'markdown' ? 'md' : meta.format === 'quiz' ? 'json' : 'html'}`
    const response = new Response(content, {
        headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `inline; filename="${filename}"`,
            'Content-Security-Policy': "sandbox; default-src 'none'",
            'Cache-Control': 'private, no-store',
            'Referrer-Policy': 'no-referrer',
            'X-Robots-Tag': 'noindex, nofollow',
            'X-Content-Type-Options': 'nosniff',
        },
    })
    return { ok: true, response, grant, format: meta.format }
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
@media (prefers-color-scheme: dark) { :root { --text:hsl(0deg 0% 90%); --muted:hsl(0deg 0% 65%); --border:hsl(230deg 8% 20%); --bg:hsl(240deg 8% 8%); --code:hsl(235deg 8% 15%); --link:hsl(43deg 94% 57%); color-scheme: dark; } }
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
