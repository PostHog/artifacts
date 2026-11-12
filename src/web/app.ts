import { AuthorizationError, CimdFetchError } from '@cloudflare/workers-oauth-provider'
import { Hono, type Context } from 'hono'
import type { AppEnv, User } from '../env'
import { type ViewerActor, type ViewerType, actorIdentity, anonymousId, guestAnalyticsId, track } from '../lib/analytics'
import type { Artifact } from '../store'
import { deriveSecret } from '../lib/crypto'
import { isAllowedRedirectUri, isSelfHostedClientId, pageCsp } from '../lib/policy'
import { type Guest, clearGuestCookie, getGuest, getGuestIdentity, guestCookie, normalizeEmail } from '../lib/guest'
import { LoginError, beginPostHogLogin, clientMetadata, finishPostHogLogin, loginErrorMessage } from '../lib/posthog-oauth'
import { clearSessionCookie, getUser, isAllowedEmail, isLocal, isRevoked, safeNext, serializeCookie, sessionCookie } from '../lib/session'
import { type Commenter, StoreError, addComment, cleanAnchor, deleteComment, getArtifact, getContent, getVersion, isInvited, isOwner, listArtifacts, listComments, listInvites, listVersions, setCommentsEnabled, setVisibility, shareUrl } from '../store'
import { type AgentTarget, type FrameAccess, agentContentUrl, contentOrigin, frameUrl, serveAgentContent, serveContent } from './content'
import { claudeCodeLink, codexLink, handoverPrompt } from './handover'
import { QuizError, parseAnswers, parseQuiz, publicQuiz, questionStats, scoreQuiz } from '../lib/quiz'
import { MAX_ATTEMPTS_PER_ARTIFACT, type Taker, attemptVersions, countAttempts, countTakerAttempts, getAttempt, listAttempts, listTakerAttempts, parseStoredAnswers, recordAttempt } from '../quiz-store'
import type { CommentsView, QuizReveal, QuizView } from './templates'
import { consentPage, guestGatePage, homePage, loginPage, messagePage, quizErrorMessage, quizResultsPage, viewerPage } from './templates'

type Env = { Bindings: AppEnv; Variables: { user: User | null } }

export const app = new Hono<Env>()

const SCOPES = ['artifacts']

app.use('*', async (c, next) => {
    c.set('user', await getUser(c.env, c.req.raw))
    await next()
    c.header('X-Robots-Tag', 'noindex, nofollow')
    c.header('X-Content-Type-Options', 'nosniff')
    // Artifact content sets its own sandbox CSP, framing rules and referrer policy.
    if (c.req.path.startsWith('/c/') || /^\/a\/[^/]+\/agent$/.test(c.req.path)) return
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
        // Only staff sign-ins are tracked: guests are customers, and we don't send their emails to project 2.
        if (result.kind === 'staff') track(c.env, c.executionCtx, 'artifacts user signed in', result.user, { source: 'web' }, c.req.raw)
        c.header('Set-Cookie', result.kind === 'staff' ? await sessionCookie(c.env, result.user) : await guestCookie(c.env, result.email, result.distinctId))
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
            track(c.env, c.executionCtx, 'artifacts mcp client connected', user, { client_id: request.clientId, is_consent_remembered: true }, c.req.raw)
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
        track(c.env, c.executionCtx, 'artifacts mcp client connected', user, { client_id: approved.request.clientId, is_consent_remembered: false }, c.req.raw)
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
    anchor: "Couldn't attach that selection. Clear it and try again.",
}

/** What a visitor sees at an invited artifact until they've signed in as someone on the list. Shows nothing about the artifact. */
function guestGate(c: Context<Env>, id: string, signedInAs?: string) {
    c.header('Cache-Control', 'no-store')
    // Signed in as someone not on the list: say so, instead of sending them round the same sign-in again.
    if (signedInAs) return c.html(guestGatePage({ id, signedInAs }), 403)
    return c.html(guestGatePage({ id, error: loginErrorMessage(c.req.query('error')) }))
}

type ViewAccess =
    | { ok: true; artifact: Artifact; owner: boolean; access: FrameAccess; guest: string | null; guestIdentity: Guest | null }
    | { ok: false; deny: 'gate'; signedInAs?: string }
    | { ok: false; deny: 'login' | 'not_found' }

/**
 * Whether this request may view the artifact, and as whom. The one place viewing is decided: the viewer page
 * and the agent handover both use it. Non-owners only ever get the latest version.
 */
async function viewAccess(c: Context<Env>, id: string): Promise<ViewAccess> {
    const user = c.get('user')
    const artifact = await getArtifact(c.env, id)
    // Private artifacts are indistinguishable from missing ones to everyone but the owner:
    // signed-out visitors are asked to sign in either way, signed-in non-owners get a 404 either way.
    // Team artifacts look the same to signed-out visitors, so a leaked team link reveals nothing.
    if (!artifact) return { ok: false, deny: user ? 'not_found' : 'login' }
    const owner = isOwner(artifact, user)
    if (owner) return { ok: true, artifact, owner, access: 'owner', guest: null, guestIdentity: null }
    if (artifact.visibility === 'invited') {
        // Invited viewers (customers) sign in with their own PostHog account; the allowlist decides, not the account.
        // Staff who aren't the owner go through the same gate; being signed in earns nothing here.
        const guestIdentity = await getGuestIdentity(c.env, c.req.raw)
        const guest = guestIdentity?.email ?? null
        if (!guest) return { ok: false, deny: 'gate' }
        if (!(await isInvited(c.env, artifact.id, guest))) return { ok: false, deny: 'gate', signedInAs: guest }
        return { ok: true, artifact, owner, access: 'invited', guest, guestIdentity }
    }
    // Every signed-in user is verified PostHog staff (see isAllowedEmail), so "signed in" is "on the team".
    if (artifact.visibility === 'team' && !user) return { ok: false, deny: 'login' }
    if (artifact.visibility === 'private') return { ok: false, deny: user ? 'not_found' : 'login' }
    return { ok: true, artifact, owner, access: artifact.visibility, guest: null, guestIdentity: null }
}

/**
 * Who a granted view counts as in analytics. Staff let in through an invite list count as staff, under their
 * PostHog ID. Customers are counted by a hash of their verified email, signed-out viewers of public links by a
 * long-lived anonymous cookie (set here when `setCookie`), so unique viewers can be counted.
 */
async function viewerActor(c: Context<Env>, view: Extract<ViewAccess, { ok: true }>, setCookie: boolean): Promise<ViewerActor> {
    const user = c.get('user')
    if (user) return { kind: 'staff', user }
    const { guestIdentity } = view
    if (guestIdentity && isAllowedEmail(c.env, guestIdentity.email)) {
        return { kind: 'staff', user: { email: guestIdentity.email, name: guestIdentity.email, distinctId: guestIdentity.distinctId } }
    }
    if (guestIdentity) return { kind: 'guest', id: await guestAnalyticsId(c.env, guestIdentity.email) }
    const anon = anonymousId(c.env, c.req.raw)
    if (setCookie) c.header('Set-Cookie', anon.setCookie, { append: true })
    return { kind: 'anonymous', id: anon.id }
}

// --- Quizzes ------------------------------------------------------------------------

/** Who is taking the quiz, as stored on the attempt. The ID is never the hashed analytics one: owners see who took it. */
function takerFrom(c: Context<Env>, view: Extract<ViewAccess, { ok: true }>, actor: ViewerActor, typedName = ''): Taker {
    if (actor.kind === 'anonymous') return { kind: 'anonymous', id: actor.id, name: typedName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60) }
    if (actor.kind === 'guest') return { kind: 'guest', id: (view.guest ?? '').toLowerCase(), name: view.guest ?? '' }
    // Staff, including staff let in through an invite list.
    const email = (c.get('user')?.email ?? view.guestIdentity?.email ?? '').toLowerCase()
    return { kind: 'staff', id: email, name: c.get('user')?.name ?? email }
}

async function loadQuiz(c: Context<Env>, artifactId: string, version: number) {
    const row = await getVersion(c.env, artifactId, version)
    if (!row || row.format !== 'quiz') return null
    const text = await getContent(c.env, row)
    if (text == null) return null
    try {
        return parseQuiz(text)
    } catch (error) {
        if (error instanceof QuizError) return null
        throw error
    }
}

async function buildQuizView(c: Context<Env>, view: Extract<ViewAccess, { ok: true }>, version: { version: number }, actor: ViewerActor): Promise<QuizView> {
    const { artifact, owner } = view
    const quiz = (await loadQuiz(c, artifact.id, version.version)) ?? { questions: [], pass_mark: 0, attempts: null, show_answers: false }
    const taker = takerFrom(c, view, actor)
    const attempts = await listTakerAttempts(c.env, artifact.id, taker)
    const isLatest = version.version === artifact.latest_version
    const used = attempts.filter((a) => a.version === version.version && !a.preview).length
    const remaining = owner || quiz.attempts === null ? null : Math.max(0, quiz.attempts - used)

    // The result of a submission: only the person who made it, or the owner, may see it.
    let result: QuizView['result']
    const wanted = c.req.query('attempt')
    const attempt = wanted ? await getAttempt(c.env, artifact.id, wanted) : null
    if (attempt && (owner || (attempt.taker_kind === taker.kind && attempt.taker_id === taker.id))) {
        let reveal: QuizReveal[] | null = null
        const taken = attempt.version === version.version ? quiz : await loadQuiz(c, artifact.id, attempt.version)
        if (taken && taken.show_answers) {
            const answers = parseStoredAnswers(attempt)
            const score = scoreQuiz(taken, answers)
            reveal = taken.questions.map((q, n) => ({
                id: q.id,
                prompt: q.prompt,
                explanation: q.explanation,
                isCorrect: score.questions[n]!.correct,
                options: q.options.map((o) => ({ id: o.id, text: o.text, chosen: (answers[q.id] ?? []).includes(o.id), correct: q.correct.includes(o.id) })),
            }))
        }
        result = { attempt, reveal }
    }
    return {
        quiz: publicQuiz(quiz as Parameters<typeof publicQuiz>[0]),
        needsName: taker.kind === 'anonymous',
        isLatest,
        owner,
        remaining,
        attempts,
        result,
        error: quizErrorMessage(c.req.query('qerr')),
    }
}

app.post('/a/:id/quiz', async (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const view = await viewAccess(c, c.req.param('id'))
    if (!view.ok) return c.text('Not found', 404)
    const { artifact, owner } = view
    const back = (error?: string) => c.redirect(`/a/${artifact.id}${error ? `?qerr=${error}` : ''}`)
    const quiz = await loadQuiz(c, artifact.id, artifact.latest_version)
    if (!quiz) return notFound(c)

    const form = await c.req.formData()
    if (Number(form.get('v')) !== artifact.latest_version) return back('stale')
    const actor = await viewerActor(c, view, true)
    const taker = takerFrom(c, view, actor, String(form.get('taker_name') ?? ''))

    // Per person, and per address for signed-out takers, who are otherwise whoever clears their cookies.
    const keys = [`${taker.kind}:${taker.id}`, ...(taker.kind === 'anonymous' ? [`ip:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`] : [])]
    const limits = await Promise.all(keys.map((key) => c.env.QUIZ_LIMITER.limit({ key })))
    if (limits.some((l) => !l.success)) return back('slow')

    if (!owner) {
        if (quiz.attempts !== null && (await countTakerAttempts(c.env, artifact.id, artifact.latest_version, taker)) >= quiz.attempts) return back('limit')
        if ((await countAttempts(c.env, artifact.id)) >= MAX_ATTEMPTS_PER_ARTIFACT) return back('full')
    }

    // Only what the form can produce: q_<question id> fields holding option ids. Anything else is refused.
    const raw: Record<string, string[]> = {}
    for (const key of new Set(form.keys())) if (key.startsWith('q_')) raw[key.slice(2)] = form.getAll(key).map(String)
    let score
    let answers
    try {
        answers = parseAnswers(quiz, raw)
        score = scoreQuiz(quiz, answers)
    } catch (error) {
        if (error instanceof QuizError) return back('invalid')
        throw error
    }
    let attempt
    try {
        attempt = await recordAttempt(c.env, { artifactId: artifact.id, version: artifact.latest_version, taker, score, answers, preview: owner })
    } catch (error) {
        if (error instanceof StoreError && error.code === 'conflict') return back('again')
        throw error
    }
    track(c.env, c.executionCtx, 'quiz submitted', actor, {
        artifact_id: artifact.id,
        artifact_owner: artifact.owner_email,
        version: attempt.version,
        attempt_no: attempt.attempt_no,
        points: score.points,
        max_points: score.max,
        percent: score.percent,
        passed: score.passed,
        is_preview: owner,
        access: view.access,
    }, c.req.raw)
    return c.redirect(`/a/${artifact.id}?attempt=${attempt.id}`)
})

// The owner's view of how people did. Names and emails are in it, so it is the owner's only.
app.get('/a/:id/results', async (c) => {
    const user = c.get('user')
    const artifact = await getArtifact(c.env, c.req.param('id'))
    if (!artifact) return user ? notFound(c) : loginRedirect(c)
    if (!isOwner(artifact, user)) return user ? notFound(c) : loginRedirect(c)
    const versions = await attemptVersions(c.env, artifact.id)
    const requested = Number(c.req.query('v') ?? versions[0]?.version ?? artifact.latest_version)
    const quiz = Number.isInteger(requested) ? await loadQuiz(c, artifact.id, requested) : null
    if (!quiz) return notFound(c)
    const attempts = await listAttempts(c.env, artifact.id, requested)
    c.header('Cache-Control', 'private, no-store')
    return c.html(quizResultsPage({ user, view: { artifact, version: requested, versions, questions: quiz.questions, stats: questionStats(quiz, attempts.map(parseStoredAnswers)), attempts } }))
})

app.get('/a/:id', async (c) => {
    const user = c.get('user')
    const view = await viewAccess(c, c.req.param('id'))
    if (!view.ok) {
        if (view.deny === 'gate') return guestGate(c, c.req.param('id'), view.signedInAs)
        return view.deny === 'login' ? loginRedirect(c) : notFound(c)
    }
    const { artifact, owner, guest, access } = view
    // Only the latest version is shared.
    if (!owner && c.req.query('v') && Number(c.req.query('v')) !== artifact.latest_version) return c.redirect(`/a/${artifact.id}`)

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
    const actor = await viewerActor(c, view, true)
    track(
        c.env,
        c.executionCtx,
        'artifact viewed',
        actor,
        {
            artifact_id: artifact.id,
            artifact_owner: artifact.owner_email,
            version: version.version,
            is_latest_version: version.version === artifact.latest_version,
            format: version.format,
            visibility: artifact.visibility,
            access,
        },
        c.req.raw
    )

    // A quiz is rendered here, by us, from its definition: the answer key never goes to the browser, and there is no iframe.
    let quizView: QuizView | null = null
    if (version.format === 'quiz') quizView = await buildQuizView(c, view, version, actor)

    return c.html(
        viewerPage({
            quiz: quizView,
            user,
            guest,
            artifact,
            versions: owner ? await listVersions(c.env, artifact.id, 100) : [],
            invites: owner ? await listInvites(c.env, artifact.id) : [],
            comments: commentsView,
            version,
            owner,
            frameSrc: quizView ? '' : await frameUrl(c.env, artifact.id, version.version, access, guest ?? undefined, !!commentsView?.enabled && version.version === artifact.latest_version),
            shareUrl: shareUrl(c.env, artifact.id),
        })
    )
})

// --- Agent handover: open the artifact in Claude Code or Codex -----------------------

// The viewer page asks for this when its "Open in agent" popover opens, so the links are fresh and each one is a
// plain link the click can follow straight away (browsers only open another app from a click). One grant per
// target, so analytics can tell which app the agent fetch came from.
app.post('/a/:id/handover', async (c) => {
    if (!sameOrigin(c)) return c.text('Forbidden', 403)
    const view = await viewAccess(c, c.req.param('id'))
    if (!view.ok) return c.text('Not found', 404)
    const { artifact, owner, access, guest } = view
    const body = await c.req.json<{ v?: unknown }>().catch(() => ({}) as { v?: unknown })
    // Owners may hand over the older version they're looking at; everyone else only ever gets the latest.
    const requested = owner && Number.isInteger(body.v) ? (body.v as number) : artifact.latest_version
    const version = await getVersion(c.env, artifact.id, requested)
    if (!version) return c.text('Not found', 404)
    // A quiz's source is its answer key: only its owner can hand it over.
    if (version.format === 'quiz' && !owner) return c.text('Not found', 404)
    const { distinctId, viewerType } = actorIdentity(await viewerActor(c, view, false))
    const prompt = async (to: AgentTarget) =>
        handoverPrompt({
            id: artifact.id,
            title: artifact.title,
            format: version.format,
            version: version.version,
            shareUrl: shareUrl(c.env, artifact.id),
            contentUrl: await agentContentUrl(c.env, artifact.id, version.version, access, guest ?? undefined, { to, who: distinctId, viewerType }),
        })
    c.header('Cache-Control', 'no-store')
    return c.json({
        claude_code: claudeCodeLink(await prompt('claude_code')),
        codex: codexLink(await prompt('codex')),
        prompt: await prompt('copy'),
    })
})

// What the handover prompt's curl downloads. No session: the signed grant in ?t= is the access.
app.get('/a/:id/agent', async (c) => {
    const result = await serveAgentContent(c.env, c.req.raw, c.req.param('id'))
    if (result.ok) {
        const { grant } = result
        track(
            c.env,
            c.executionCtx,
            'artifact sent to agent',
            { kind: 'resolved', distinctId: grant.who, viewerType: grant.vt as ViewerType },
            { artifact_id: grant.id, version: grant.v, format: result.format, target: grant.to, access: grant.pub ? 'public' : grant.team ? 'team' : grant.guest ? 'invited' : 'owner' },
            c.req.raw
        )
    }
    return result.response
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
        track(c.env, c.executionCtx, 'artifact visibility changed', user, { artifact_id: artifact.id, visibility, source: 'web' }, c.req.raw)
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
    const data = await c.req.formData()
    const field = (name: string) => String(data.get(name) ?? '')
    try {
        // The selection comes from the viewer page's own form, filled in from a message the artifact's script sent,
        // so it is untrusted text: cleaned and length-capped here, and only ever rendered escaped.
        const anchor = cleanAnchor({ exact: field('anchor_exact'), prefix: field('anchor_prefix'), suffix: field('anchor_suffix') })
        await addComment(c.env, artifact, who.me, field('body'), anchor)
    } catch (error) {
        if (!(error instanceof StoreError)) throw error
        return back(error.message === 'anchor' ? 'anchor' : error.code === 'invalid' ? 'empty' : error.message.includes('limit') && !error.message.includes('characters') ? 'full' : 'long')
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
