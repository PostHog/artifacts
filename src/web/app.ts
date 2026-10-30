import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider'
import { Hono, type Context } from 'hono'
import type { AppEnv, User } from '../env'
import { LoginError, beginPostHogLogin, clientMetadata, finishPostHogLogin } from '../lib/posthog-oauth'
import { clearSessionCookie, getUser, isAllowedEmail, isLocal, safeNext, sessionCookie } from '../lib/session'
import { StoreError, getArtifact, getVersion, isOwner, listArtifacts, listVersions, setVisibility, shareUrl } from '../store'
import { frameUrl, serveContent } from './content'
import { consentPage, homePage, loginPage, messagePage, viewerPage } from './templates'

type Env = { Bindings: AppEnv; Variables: { user: User | null } }

export const app = new Hono<Env>()

const SCOPES = ['artifacts']

app.use('*', async (c, next) => {
    c.set('user', await getUser(c.env, c.req.raw))
    await next()
    c.header('X-Robots-Tag', 'noindex, nofollow')
    // Never leak share links to other sites, but keep Origin on our own posts.
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Content-Type-Options', 'nosniff')
    // Chrome pages may only be framed by ourselves; artifact content sets its own policy.
    if (!c.req.path.startsWith('/c/')) c.header('X-Frame-Options', 'DENY')
})

const notFound = (c: Context<Env>) =>
    c.html(
        messagePage({
            user: c.get('user'),
            title: 'Nothing to see here',
            message: "This artifact doesn't exist, or it hasn't been shared with you.",
            status: 404,
        }),
        404
    )

const loginRedirect = (c: Context<Env>) => c.redirect(`/login?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ''))}`)

/** Rejects cross-site form/fetch posts. SameSite=Lax already blocks the cookie; this is defence in depth. */
const sameOrigin = (c: Context<Env>) => {
    const site = c.req.header('Sec-Fetch-Site')
    if (site) return site === 'same-origin' || site === 'none'
    const origin = c.req.header('Origin')
    return !origin || origin === new URL(c.env.PUBLIC_URL).origin
}

app.get('/', async (c) => {
    const user = c.get('user')
    const artifacts = user ? await listArtifacts(c.env, user, { limit: 100 }) : []
    return c.html(homePage({ user, artifacts, publicUrl: c.env.PUBLIC_URL }))
})

// --- Sign-in -----------------------------------------------------------------

const devLoginEnabled = (env: AppEnv) => env.DEV_LOGIN === 'true' && isLocal(env)

app.get('/login', (c) => {
    const next = safeNext(c.req.query('next'))
    if (c.get('user')) return c.redirect(next)
    return c.html(loginPage({ next, error: c.req.query('error'), dev: devLoginEnabled(c.env) }))
})

// Client ID Metadata Document: our client_id *is* this URL, so PostHog fetches it to learn our redirect URI.
app.get('/oauth/client-metadata.json', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(clientMetadata(c.env))
})

app.get('/auth/posthog', async (c) => {
    try {
        return await beginPostHogLogin(c.env, safeNext(c.req.query('next')))
    } catch (error) {
        if (error instanceof LoginError) return c.redirect(`/login?error=${encodeURIComponent(error.message)}`)
        throw error
    }
})

app.get('/auth/posthog/callback', async (c) => {
    try {
        const { user, next } = await finishPostHogLogin(c.env, c.req.raw)
        c.header('Set-Cookie', await sessionCookie(c.env, user))
        return c.redirect(next)
    } catch (error) {
        if (error instanceof LoginError) return c.redirect(`/login?error=${encodeURIComponent(error.message)}`)
        throw error
    }
})

app.post('/login/dev', async (c) => {
    if (!devLoginEnabled(c.env) || !sameOrigin(c)) return c.notFound()
    const form = await c.req.formData()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const next = safeNext(String(form.get('next') ?? '/'))
    if (!isAllowedEmail(c.env, email)) {
        return c.redirect(`/login?next=${encodeURIComponent(next)}&error=${encodeURIComponent(`Use an @${c.env.ALLOWED_EMAIL_DOMAIN} address`)}`)
    }
    const name = String(form.get('name') ?? '').trim() || email.split('@')[0]!
    c.header('Set-Cookie', await sessionCookie(c.env, { email, name }))
    return c.redirect(next)
})

app.get('/logout', (c) => {
    c.header('Set-Cookie', clearSessionCookie(c.env))
    return c.redirect('/')
})

// --- MCP OAuth authorization (the authorization server's consent step) ------

function renderAuthError(c: Context<Env>, error: unknown) {
    if (error instanceof AuthorizationError && error.redirectTo) return c.redirect(error.redirectTo)
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : 'This app could not be verified.'
        return c.html(messagePage({ user: c.get('user'), title: "Couldn't connect", message: message ?? 'Invalid request' }), 400)
    }
    throw error
}

const rememberConsent = (env: AppEnv, user: User) => ({ secret: env.SESSION_SECRET, subject: user.email })

app.get('/authorize', async (c) => {
    const user = c.get('user')
    if (!user) return loginRedirect(c)
    const oauth = c.env.OAUTH_PROVIDER
    try {
        const request = await oauth.parseAuthRequest(c.req.raw)
        if (await oauth.isConsentRemembered(c.req.raw, request, rememberConsent(c.env, user))) {
            const { redirectTo } = await oauth.completeAuthorization({
                request,
                userId: user.email,
                metadata: {},
                scope: request.scope.length ? request.scope : SCOPES,
                props: user,
            })
            return c.redirect(redirectTo)
        }
        const details = await oauth.describeConsent(request)
        const consent = await oauth.beginConsent(request)
        consent.headers.set('Content-Type', 'text/html; charset=utf-8')
        return new Response(await consentPage({ user, details, handle: consent.handle }), { headers: consent.headers })
    } catch (error) {
        return renderAuthError(c, error)
    }
})

app.post('/authorize', async (c) => {
    const user = c.get('user')
    if (!user) return loginRedirect(c)
    const oauth = c.env.OAUTH_PROVIDER
    try {
        const form = await c.req.formData()
        const handle = String(form.get('handle') ?? '')
        if (form.get('decision') !== 'approve') {
            const denied = await oauth.denyConsent(c.req.raw, handle)
            return new Response(null, { status: 302, headers: denied.headers })
        }
        const approved = await oauth.approveConsent(c.req.raw, handle, {
            scope: SCOPES,
            remember: rememberConsent(c.env, user),
        })
        const { redirectTo } = await oauth.completeAuthorization({
            request: approved.request,
            userId: user.email,
            metadata: {},
            scope: approved.request.scope,
            props: user,
        })
        approved.headers.set('Location', redirectTo)
        return new Response(null, { status: 302, headers: approved.headers })
    } catch (error) {
        return renderAuthError(c, error)
    }
})

// --- Artifacts -----------------------------------------------------------------

app.get('/a/:id', async (c) => {
    const user = c.get('user')
    const artifact = await getArtifact(c.env, c.req.param('id'))
    if (!artifact) return notFound(c)
    const owner = isOwner(artifact, user)

    if (!owner) {
        // Private artifacts are indistinguishable from missing ones to everyone but the owner.
        if (artifact.visibility !== 'public') return user ? notFound(c) : loginRedirect(c)
        // Only the latest version is shared.
        if (c.req.query('v') && Number(c.req.query('v')) !== artifact.latest_version) return c.redirect(`/a/${artifact.id}`)
    }

    const requested = owner && c.req.query('v') ? Number(c.req.query('v')) : artifact.latest_version
    const version = Number.isInteger(requested) ? await getVersion(c.env, artifact.id, requested) : null
    if (!version) return owner ? c.redirect(`/a/${artifact.id}`) : notFound(c)

    return c.html(
        viewerPage({
            user,
            artifact,
            versions: owner ? await listVersions(c.env, artifact.id) : [],
            version,
            owner,
            frameSrc: await frameUrl(c.env, artifact.id, version.version, !owner),
            shareUrl: shareUrl(c.env, artifact.id),
        })
    )
})

app.post('/a/:id/visibility', async (c) => {
    const user = c.get('user')
    if (!user) return c.text('Sign in required', 401)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const { visibility } = await c.req.json<{ visibility?: string }>().catch(() => ({ visibility: undefined }))
    if (visibility !== 'private' && visibility !== 'public') return c.text('visibility must be "private" or "public"', 400)
    try {
        const artifact = await setVisibility(c.env, user, c.req.param('id'), visibility)
        return c.json({ id: artifact.id, visibility: artifact.visibility, url: shareUrl(c.env, artifact.id) })
    } catch (error) {
        if (error instanceof StoreError) return c.text('Not found', 404)
        throw error
    }
})

app.get('/c/:id/:version', async (c) => {
    const version = Number(c.req.param('version'))
    if (!Number.isInteger(version) || version < 1) return c.text('Not found', 404)
    return serveContent(c.env, c.req.raw, c.req.param('id'), version)
})

app.notFound(notFound)

app.onError((error, c) => {
    console.error(error)
    return c.html(messagePage({ user: c.get('user') ?? null, title: 'Something broke', message: 'Please try again in a moment.' }), 500)
})
