import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider'
import { Hono, type Context } from 'hono'
import type { AppEnv, User } from '../env'
import type { Artifact } from '../store'
import { deriveSecret } from '../lib/crypto'
import { isAllowedRedirectUri, isSelfHostedClientId, pageCsp } from '../lib/policy'
import { clearGuestCookie, getGuest, guestCookie, normalizeEmail } from '../lib/guest'
import { LoginError, beginPostHogLogin, clientMetadata, finishPostHogLogin, loginErrorMessage } from '../lib/posthog-oauth'
import { clearSessionCookie, getUser, isAllowedEmail, isLocal, isRevoked, safeNext, serializeCookie, sessionCookie } from '../lib/session'
import { type Commenter, StoreError, addComment, deleteComment, getArtifact, getVersion, isInvited, isOwner, listArtifacts, listComments, listInvites, listVersions, setCommentsEnabled, setVisibility, shareUrl } from '../store'
import { contentOrigin, frameUrl, serveContent } from './content'
import type { CommentsView } from './templates'
import { consentPage, guestGatePage, homePage, loginPage, messagePage, viewerPage } from './templates'

type Env = { Bindings: AppEnv; Variables: { user: User | null } }

export const app = new Hono<Env>()

const SCOPES = ['artifacts']

app.use('*', async (c, next) => {
    c.set('user', await getUser(c.env, c.req.raw))
    await next()
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('X-Content-Type-Options', 'nosniff')
    // Artifact content sets its own sandbox CSP, framing rules and referrer policy.
    if (c.req.path.startsWith('/c/')) return
    // Never leak share links to other sites, but keep Origin on our own posts.
    c.header('Referrer-Policy', 'same-origin')
    c.header('X-Frame-Options', 'DENY')
    c.header('Content-Security-Policy', pageCsp(c.env, contentOrigin(c.env)))
    // Severs window.opener from popups an artifact opens, so they can't navigate this tab (reverse tabnabbing).
    c.header('Cross-Origin-Opener-Policy', 'same-origin')
    c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
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

const loginError = (c: Context<Env>, error: LoginError, next = '/') =>
    c.redirect(`/login?error=${error.code}${next === '/' ? '' : `&next=${encodeURIComponent(next)}`}`)

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
    const next = safeNext(c.env, c.req.query('next'))
    if (c.get('user')) return c.redirect(next)
    return c.html(loginPage({ next, error: loginErrorMessage(c.req.query('error')), dev: devLoginEnabled(c.env) }))
})

// Client ID Metadata Document: our client_id *is* this URL, so PostHog fetches it to learn our redirect URI.
app.get('/oauth/client-metadata.json', (c) => {
    c.header('Cache-Control', 'public, max-age=3600')
    return c.json(clientMetadata(c.env))
})

app.get('/auth/posthog', async (c) => {
    try {
        return await beginPostHogLogin(c.env, safeNext(c.env, c.req.query('next')))
    } catch (error) {
        if (error instanceof LoginError) return loginError(c, error)
        throw error
    }
})

app.get('/auth/posthog/callback', async (c) => {
    try {
        const result = await finishPostHogLogin(c.env, c.req.raw)
        // Staff get a session. Invited viewers get a guest cookie, which only opens artifacts that list them.
        c.header('Set-Cookie', result.kind === 'staff' ? await sessionCookie(c.env, result.user) : await guestCookie(c.env, result.email))
        // The login state is single-use.
        c.header('Set-Cookie', serializeCookie(c.env, 'login', '', 0), { append: true })
        return c.redirect(safeNext(c.env, result.next))
    } catch (error) {
        if (error instanceof LoginError) {
            if (error.returnTo) {
                c.header('Set-Cookie', serializeCookie(c.env, 'login', '', 0))
                return c.redirect(`${safeNext(c.env, error.returnTo)}?error=${error.code}`)
            }
            return loginError(c, error)
        }
        throw error
    }
})

app.post('/login/dev', async (c) => {
    if (!devLoginEnabled(c.env) || !sameOrigin(c)) return c.notFound()
    const form = await c.req.formData()
    const email = String(form.get('email') ?? '').trim().toLowerCase()
    const next = safeNext(c.env, String(form.get('next') ?? '/'))
    if (!isAllowedEmail(c.env, email)) return loginError(c, new LoginError('not_allowed'), next)
    if (await isRevoked(c.env, email)) return loginError(c, new LoginError('revoked'), next)
    const name = String(form.get('name') ?? '').trim() || email.split('@')[0]!
    c.header('Set-Cookie', await sessionCookie(c.env, { email, name }))
    return c.redirect(next)
})

app.post('/logout', (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
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

// The OAuth library signs its own cookies with this; derive it so no key is shared between formats.
const rememberConsent = async (env: AppEnv, user: User) => ({ secret: await deriveSecret(env.SESSION_SECRET, 'oauth-consent'), subject: user.email })

/** Our own client policy, on top of the library's validation (see lib/policy.ts). */
function clientPolicyError(c: Context<Env>, request: { clientId: string; redirectUri: string }) {
    if (isSelfHostedClientId(c.env, request.clientId) || !isAllowedRedirectUri(c.env, request.redirectUri)) {
        console.warn('mcp authorize refused by client policy', { clientId: request.clientId, redirectHost: URL.parse(request.redirectUri)?.host })
        return c.html(
            messagePage({
                user: c.get('user'),
                title: "Couldn't connect",
                message: 'This app isn\'t allowed to connect to PostHog Artifacts. Use Claude Code, claude.ai, or another MCP client running on your computer.',
            }),
            400
        )
    }
    return null
}

app.get('/authorize', async (c) => {
    const user = c.get('user')
    if (!user) return loginRedirect(c)
    const oauth = c.env.OAUTH_PROVIDER
    try {
        const request = await oauth.parseAuthRequest(c.req.raw)
        const refused = clientPolicyError(c, request)
        if (refused) return refused
        if (await oauth.isConsentRemembered(c.req.raw, request, await rememberConsent(c.env, user))) {
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
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
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
            remember: await rememberConsent(c.env, user),
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

// --- Comments ---------------------------------------------------------------------

/**
 * Who a request may comment as on this artifact, or null. Mirrors who can view it, minus anonymous visitors
 * (a public link carries no identity): the owner; a signed-in staff member on team and public artifacts; an
 * invited guest on an invited one. Private artifacts take no comments from anyone but the owner.
 */
function commenterFor(artifact: Artifact, user: User | null, guest: string | null, owner: boolean): Commenter | null {
    if (owner && user) return { email: user.email, name: user.name, kind: 'staff' }
    if (artifact.visibility === 'invited') return guest ? { email: guest, name: `${guest.split('@')[0]} (guest)`, kind: 'guest' } : null
    if (artifact.visibility === 'private') return null
    return user ? { email: user.email, name: user.name, kind: 'staff' } : null
}

async function commenterFromRequest(c: Context<Env>, artifact: Artifact): Promise<{ me: Commenter; owner: boolean } | null> {
    const user = c.get('user')
    const owner = isOwner(artifact, user)
    let guest: string | null = null
    if (!owner && artifact.visibility === 'invited') {
        guest = await getGuest(c.env, c.req.raw)
        // Re-checked here, not trusted from the cookie: removing someone from the list stops their comments too.
        if (!guest || !(await isInvited(c.env, artifact.id, guest))) return null
    }
    const me = commenterFor(artifact, user, guest, owner)
    return me ? { me, owner } : null
}

const COMMENT_ERRORS: Record<string, string> = {
    empty: 'Write something first.',
    long: 'That comment is too long.',
    full: 'This artifact has reached its comment limit.',
    slow: 'Too many comments. Wait a minute and try again.',
}

/** What a visitor sees at an invited artifact until they've signed in as someone on the list. Shows nothing about the artifact. */
function guestGate(c: Context<Env>, id: string) {
    c.header('Cache-Control', 'no-store')
    return c.html(guestGatePage({ id, error: loginErrorMessage(c.req.query('error')) }))
}

app.get('/a/:id', async (c) => {
    const user = c.get('user')
    const artifact = await getArtifact(c.env, c.req.param('id'))
    // Private artifacts are indistinguishable from missing ones to everyone but the owner:
    // signed-out visitors are asked to sign in either way, signed-in non-owners get a 404 either way.
    // Team artifacts look the same to signed-out visitors, so a leaked team link reveals nothing.
    if (!artifact) return user ? notFound(c) : loginRedirect(c)
    const owner = isOwner(artifact, user)
    let guest: string | null = null

    if (!owner) {
        if (artifact.visibility === 'invited') {
            // Invited viewers (customers) sign in with their own PostHog account; the allowlist decides, not the account.
            // Staff who aren't the owner go through the same gate; being signed in earns nothing here.
            guest = await getGuest(c.env, c.req.raw)
            if (!guest || !(await isInvited(c.env, artifact.id, guest))) return guestGate(c, artifact.id)
        } else {
            // Every signed-in user is verified PostHog staff (see isAllowedEmail), so "signed in" is "on the team".
            if (artifact.visibility === 'team' && !user) return loginRedirect(c)
            if (artifact.visibility === 'private') return user ? notFound(c) : loginRedirect(c)
        }
        // Only the latest version is shared.
        if (c.req.query('v') && Number(c.req.query('v')) !== artifact.latest_version) return c.redirect(`/a/${artifact.id}`)
    }

    const requested = owner && c.req.query('v') ? Number(c.req.query('v')) : artifact.latest_version
    const version = Number.isInteger(requested) ? await getVersion(c.env, artifact.id, requested) : null
    if (!version) return owner ? c.redirect(`/a/${artifact.id}`) : notFound(c)

    // Owners see the comment controls even when comments are off (to turn them on). Everyone else sees the panel
    // only when comments are on and they're signed in as someone who can comment: anonymous link viewers see none.
    const me = commenterFor(artifact, user, guest, owner)
    const commentsView: CommentsView | null =
        owner || (artifact.comments_enabled && me)
            ? {
                  enabled: !!artifact.comments_enabled,
                  items: artifact.comments_enabled ? await listComments(c.env, artifact.id) : [],
                  me,
                  owner,
                  open: c.req.query('c') === '1',
                  error: COMMENT_ERRORS[c.req.query('cerr') ?? ''],
              }
            : null

    c.header('Cache-Control', 'private, no-store')
    const access = owner ? 'owner' : artifact.visibility === 'team' ? 'team' : artifact.visibility === 'invited' ? 'invited' : 'public'
    return c.html(
        viewerPage({
            user,
            guest,
            artifact,
            versions: owner ? await listVersions(c.env, artifact.id, 100) : [],
            invites: owner ? await listInvites(c.env, artifact.id) : [],
            comments: commentsView,
            version,
            owner,
            frameSrc: await frameUrl(c.env, artifact.id, version.version, access, guest ?? undefined),
            shareUrl: shareUrl(c.env, artifact.id),
        })
    )
})

// --- Invited viewers: sign in with a PostHog account ------------------------------

app.get('/a/:id/signin/:region', async (c) => {
    const artifact = await getArtifact(c.env, c.req.param('id'))
    const region = c.req.param('region')
    if (!artifact || artifact.visibility !== 'invited' || (region !== 'us' && region !== 'eu')) return notFound(c)
    try {
        return await beginPostHogLogin(c.env, `/a/${artifact.id}`, { region })
    } catch (error) {
        if (error instanceof LoginError) return c.redirect(`/a/${artifact.id}?error=${error.code}`)
        throw error
    }
})

// Local-only stand-in for the PostHog sign-in above, which needs the real PostHog. Any address, like a real customer.
app.post('/login/dev-guest', async (c) => {
    if (!devLoginEnabled(c.env) || !sameOrigin(c)) return c.notFound()
    const email = normalizeEmail(String((await c.req.formData()).get('email') ?? ''))
    if (!email) return c.notFound()
    c.header('Set-Cookie', await guestCookie(c.env, email))
    return c.redirect('/')
})

app.post('/a/:id/signout', (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    c.header('Set-Cookie', clearGuestCookie(c.env))
    return c.redirect(`/a/${c.req.param('id')}`)
})

app.post('/a/:id/visibility', async (c) => {
    const user = c.get('user')
    if (!user) return c.text('Sign in required', 401)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const body = await c.req.json<{ visibility?: string; invited?: unknown }>().catch(() => ({}) as { visibility?: string; invited?: unknown })
    const { visibility } = body
    if (visibility !== 'private' && visibility !== 'team' && visibility !== 'invited' && visibility !== 'public') {
        return c.text('visibility must be "private", "team", "invited" or "public"', 400)
    }
    if (body.invited !== undefined && (!Array.isArray(body.invited) || !body.invited.every((e) => typeof e === 'string'))) {
        return c.text('invited must be a list of emails or domains', 400)
    }
    try {
        const artifact = await setVisibility(c.env, user, c.req.param('id'), visibility, body.invited as string[] | undefined)
        return c.json({ id: artifact.id, visibility: artifact.visibility, url: shareUrl(c.env, artifact.id), invited: await listInvites(c.env, artifact.id) })
    } catch (error) {
        if (error instanceof StoreError) return error.code === 'invalid' ? c.text(error.message, 400) : c.text('Not found', 404)
        throw error
    }
})

app.post('/a/:id/comments', async (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const artifact = await getArtifact(c.env, c.req.param('id'))
    if (!artifact || !artifact.comments_enabled) return notFound(c)
    const who = await commenterFromRequest(c, artifact)
    if (!who) return notFound(c)
    const back = (error?: string) => c.redirect(`/a/${artifact.id}?c=1${error ? `&cerr=${error}` : ''}`)
    const { success } = await c.env.COMMENT_LIMITER.limit({ key: `${who.me.kind}:${who.me.email}` })
    if (!success) return back('slow')
    try {
        await addComment(c.env, artifact, who.me, String((await c.req.formData()).get('body') ?? ''))
    } catch (error) {
        if (!(error instanceof StoreError)) throw error
        return back(error.code === 'invalid' ? 'empty' : error.message.includes('limit') && !error.message.includes('characters') ? 'full' : 'long')
    }
    return back()
})

app.post('/a/:id/comments/settings', async (c) => {
    const user = c.get('user')
    if (!user) return c.text('Sign in required', 401)
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    try {
        await setCommentsEnabled(c.env, user, c.req.param('id'), String((await c.req.formData()).get('enabled')) === '1')
    } catch (error) {
        if (error instanceof StoreError) return c.text('Not found', 404)
        throw error
    }
    return c.redirect(`/a/${c.req.param('id')}?c=1`)
})

app.post('/a/:id/comments/:commentId/delete', async (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const artifact = await getArtifact(c.env, c.req.param('id'))
    if (!artifact) return notFound(c)
    const who = await commenterFromRequest(c, artifact)
    if (!who) return notFound(c)
    await deleteComment(c.env, artifact, c.req.param('commentId'), { email: who.me.email, kind: who.me.kind, owner: who.owner })
    return c.redirect(`/a/${artifact.id}?c=1`)
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
