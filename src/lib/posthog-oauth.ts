import type { AppEnv, User } from '../env'
import { base64url, fromBase64url, openToken, randomId, sealToken } from './crypto'
import { normalizeEmail } from './guest'
import { cookieName, isAllowedEmail, isRevoked, readCookie, serializeCookie } from './session'

/**
 * "Sign in with PostHog" over OAuth 2.1 + OIDC (https://posthog.com/docs/api/oauth).
 *
 * We're a public client (PKCE, no secret). In production our client_id is the URL of a Client ID
 * Metadata Document we serve ourselves, so there's nothing to register or rotate. PostHog can't
 * fetch a document from localhost, so local dev registers a client dynamically instead.
 */

const LOGIN_TTL = 600
const SCOPES = 'openid email profile'

interface LoginState {
    state: string
    verifier: string
    nonce: string
    clientId: string
    next: string
    /** The OAuth host this login was sent to; the token and issuer checks use it, not the environment. */
    host: string
    /** An invited viewer signing in, not staff: any verified email is accepted here and the allowlist decides. */
    guest?: boolean
}

/**
 * Errors travel to the login page as a code in the query string, never as text, so a crafted
 * link can't put attacker-written words on the real sign-in page.
 */
const LOGIN_ERRORS = {
    unavailable: "Couldn't reach PostHog sign-in. Please try again in a moment.",
    expired: 'Your sign-in link expired. Please try again.',
    cancelled: 'PostHog sign-in was cancelled.',
    failed: 'PostHog sign-in failed. Please try again.',
    not_allowed: "This sign-in is for PostHog staff. If someone shared a document with you, open the link they sent you and sign in from there.",
    not_verified: "Your PostHog account's email address isn't verified yet. Verify it in PostHog, then try again.",
    revoked: 'Your access to Artifacts has been revoked.',
} as const
export type LoginErrorCode = keyof typeof LOGIN_ERRORS

export function loginErrorMessage(code: string | undefined): string | undefined {
    return code && Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : undefined
}

export class LoginError extends Error {
    /** Set for invited-viewer logins: where to send the visitor back to with the error shown. */
    returnTo?: string
    constructor(public code: LoginErrorCode) {
        super(LOGIN_ERRORS[code])
    }
}

const oauthHost = (env: AppEnv) => env.POSTHOG_OAUTH_HOST || 'https://us.posthog.com'
export type Region = 'us' | 'eu'
const hostFor = (env: AppEnv, region: Region) => (region === 'eu' ? env.POSTHOG_EU_OAUTH_HOST || 'https://eu.posthog.com' : oauthHost(env))
const redirectUri = (env: AppEnv) => `${env.PUBLIC_URL}/auth/posthog/callback`
export const clientMetadataUrl = (env: AppEnv) => `${env.PUBLIC_URL}/oauth/client-metadata.json`

const usesClientMetadataDocument = (env: AppEnv) => new URL(env.PUBLIC_URL).protocol === 'https:'

/** Served at clientMetadataUrl(); PostHog fetches it to learn who we are. */
export function clientMetadata(env: AppEnv) {
    return {
        client_id: clientMetadataUrl(env),
        // PostHog rejects client names starting with "posthog".
        client_name: 'Artifacts by PostHog',
        client_uri: env.PUBLIC_URL,
        logo_uri: `${env.PUBLIC_URL}/logo-512.png`,
        redirect_uris: [redirectUri(env)],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        // The app's scope ceiling. OIDC scopes are always allowed on top of it, and PostHog rejects a
        // ceiling made only of them; leaving it out grants every self-serve scope. user:read is the narrowest real one.
        'com.posthog': { scopes: ['user:read'] },
    }
}

async function clientId(env: AppEnv, host: string): Promise<string> {
    if (usesClientMetadataDocument(env)) return clientMetadataUrl(env)

    const cacheKey = `posthog-oauth-client:${host}:${redirectUri(env)}`
    const cached = await env.OAUTH_KV.get(cacheKey)
    if (cached) return cached
    const response = await fetch(`${host}/oauth/register/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            client_name: 'Artifacts by PostHog (local dev)',
            redirect_uris: [redirectUri(env)],
            grant_types: ['authorization_code'],
            response_types: ['code'],
            token_endpoint_auth_method: 'none',
            // Self-registered clients may not request scopes; they get PostHog's default set.
        }),
    })
    if (!response.ok) {
        console.error('posthog client registration failed', response.status, await response.text())
        throw new LoginError('unavailable')
    }
    const { client_id } = await response.json<{ client_id: string }>()
    await env.OAUTH_KV.put(cacheKey, client_id)
    return client_id
}

/** Starts PostHog sign-in. State, nonce and the PKCE verifier live in a short-lived signed cookie bound to this browser. */
export async function beginPostHogLogin(env: AppEnv, next: string, guest?: { region: Region }): Promise<Response> {
    const host = guest ? hostFor(env, guest.region) : oauthHost(env)
    const login: LoginState = {
        state: randomId(32),
        verifier: randomId(64),
        nonce: randomId(32),
        clientId: await clientId(env, host),
        next,
        host,
        ...(guest && { guest: true }),
    }
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(login.verifier)))
    const url = new URL(`${login.host}/oauth/authorize/`)
    url.search = new URLSearchParams({
        client_id: login.clientId,
        redirect_uri: redirectUri(env),
        response_type: 'code',
        scope: SCOPES,
        state: login.state,
        nonce: login.nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
    }).toString()
    return new Response(null, {
        status: 302,
        headers: {
            Location: url.toString(),
            'Set-Cookie': serializeCookie(env, 'login', await sealToken(env.SESSION_SECRET, 'login', login, LOGIN_TTL), LOGIN_TTL),
        },
    })
}

interface Claims {
    sub?: string
    email?: string
    email_verified?: boolean
    given_name?: string
    family_name?: string
    aud?: string | string[]
    exp?: number
    nonce?: string
    iss?: string
}

/** The issuer must be exactly the host we sent the user to (US Cloud for staff; US or EU for invited viewers). */
function trustedIssuer(host: string, iss: string | undefined): boolean {
    try {
        const url = new URL(iss ?? '')
        return url.protocol === 'https:' && url.origin === new URL(host).origin
    } catch {
        return false
    }
}

/**
 * The ID token arrives straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 accepts
 * in place of a signature check. We still bind it to the issuer, this client, this login (nonce) and its expiry.
 */
function idTokenClaims(idToken: string, login: LoginState): Claims {
    let claims: Claims
    try {
        claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split('.')[1] ?? ''))) as Claims
    } catch {
        throw new LoginError('failed')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
        !trustedIssuer(login.host, claims.iss) ||
        !audiences.includes(login.clientId) ||
        (claims.exp ?? 0) < Date.now() / 1000 ||
        claims.nonce !== login.nonce
    ) {
        console.warn('posthog id token rejected', { iss: claims.iss, audOk: audiences.includes(login.clientId), nonceOk: claims.nonce === login.nonce })
        throw new LoginError('failed')
    }
    return claims
}

export type LoginResult = { kind: 'staff'; user: User; next: string } | { kind: 'guest'; email: string; next: string }

export async function finishPostHogLogin(env: AppEnv, request: Request): Promise<LoginResult> {
    const params = new URL(request.url).searchParams
    const login = await openToken<LoginState>(env.SESSION_SECRET, 'login', readCookie(request, cookieName(env, 'login')))
    if (!login || login.state !== params.get('state')) throw new LoginError('expired')
    try {
        return await completeLogin(env, params, login)
    } catch (error) {
        // An invited viewer should land back on the artifact they came for, with the reason, not on the staff login page.
        if (error instanceof LoginError && login.guest) error.returnTo = login.next
        throw error
    }
}

async function completeLogin(env: AppEnv, params: URLSearchParams, login: LoginState): Promise<LoginResult> {
    if (params.get('error')) throw new LoginError('cancelled')

    const tokenResponse = await fetch(`${login.host}/oauth/token/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: params.get('code') ?? '',
            redirect_uri: redirectUri(env),
            client_id: login.clientId,
            code_verifier: login.verifier,
        }),
    })
    if (!tokenResponse.ok) {
        console.error('posthog token exchange failed', tokenResponse.status, await tokenResponse.text())
        throw new LoginError('failed')
    }
    const tokens = await tokenResponse.json<{ access_token: string; id_token?: string }>()

    let claims: Claims
    if (tokens.id_token) {
        claims = idTokenClaims(tokens.id_token, login)
    } else {
        const userinfo = await fetch(`${login.host}/oauth/userinfo/`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        if (!userinfo.ok) throw new LoginError('failed')
        claims = await userinfo.json<Claims>()
    }

    const name = [claims.given_name, claims.family_name].filter(Boolean).join(' ')
    // Anyone can sign up to PostHog with any address, so the email must be verified, not just match.
    if (login.guest) {
        const email = claims.email ? normalizeEmail(claims.email) : null
        if (!email || claims.email_verified !== true) throw new LoginError('not_verified')
        if (await isRevoked(env, email)) throw new LoginError('revoked')
        return { kind: 'guest', email, next: login.next }
    }
    if (!claims.email || claims.email_verified !== true || !isAllowedEmail(env, claims.email)) {
        console.warn('posthog sign-in rejected', { hasEmail: !!claims.email, emailVerified: claims.email_verified, claims: Object.keys(claims) })
        throw new LoginError('not_allowed')
    }
    const email = claims.email.toLowerCase()
    if (await isRevoked(env, email)) throw new LoginError('revoked')
    const distinctId = await posthogDistinctId(login.host, tokens.access_token)
    return { kind: 'staff', user: { email, name: name || email, ...(distinctId ? { distinctId } : {}) }, next: login.next }
}

/** The user's own distinct_id in PostHog, for analytics only. Best effort: sign-in never fails over it. */
async function posthogDistinctId(host: string, accessToken: string): Promise<string | undefined> {
    try {
        const response = await fetch(`${host}/api/users/@me/`, { headers: { Authorization: `Bearer ${accessToken}` } })
        if (!response.ok) {
            console.warn('posthog user lookup failed', response.status)
            return undefined
        }
        const { distinct_id } = await response.json<{ distinct_id?: unknown }>()
        return typeof distinct_id === 'string' && distinct_id.length > 0 && distinct_id.length <= 200 ? distinct_id : undefined
    } catch (error) {
        console.warn('posthog user lookup failed', String(error))
        return undefined
    }
}
