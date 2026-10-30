import type { AppEnv, User } from '../env'
import { base64url, fromBase64url, openToken, randomId, sealToken } from './crypto'
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
    not_allowed: 'Only PostHog accounts with a verified company email can sign in.',
    revoked: 'Your access to Artifacts has been revoked.',
} as const
export type LoginErrorCode = keyof typeof LOGIN_ERRORS

export function loginErrorMessage(code: string | undefined): string | undefined {
    return code && Object.hasOwn(LOGIN_ERRORS, code) ? LOGIN_ERRORS[code as LoginErrorCode] : undefined
}

export class LoginError extends Error {
    constructor(public code: LoginErrorCode) {
        super(LOGIN_ERRORS[code])
    }
}

const oauthHost = (env: AppEnv) => env.POSTHOG_OAUTH_HOST || 'https://oauth.posthog.com'
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
        'com.posthog': { scopes: SCOPES.split(' ') },
    }
}

async function clientId(env: AppEnv): Promise<string> {
    if (usesClientMetadataDocument(env)) return clientMetadataUrl(env)

    const cacheKey = `posthog-oauth-client:${oauthHost(env)}:${redirectUri(env)}`
    const cached = await env.OAUTH_KV.get(cacheKey)
    if (cached) return cached
    const response = await fetch(`${oauthHost(env)}/oauth/register/`, {
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
export async function beginPostHogLogin(env: AppEnv, next: string): Promise<Response> {
    const login: LoginState = {
        state: randomId(32),
        verifier: randomId(64),
        nonce: randomId(32),
        clientId: await clientId(env),
        next,
    }
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(login.verifier)))
    const url = new URL(`${oauthHost(env)}/oauth/authorize/`)
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

/** The region-agnostic host may hand back an ID token issued by the user's regional instance. */
function trustedIssuer(env: AppEnv, iss: string | undefined): boolean {
    try {
        const url = new URL(iss ?? '')
        if (url.protocol !== 'https:') return false
        return url.hostname === new URL(oauthHost(env)).hostname || /^(us|eu|oauth)\.posthog\.com$/.test(url.hostname)
    } catch {
        return false
    }
}

/**
 * The ID token arrives straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 accepts
 * in place of a signature check. We still bind it to the issuer, this client, this login (nonce) and its expiry.
 */
function idTokenClaims(env: AppEnv, idToken: string, login: LoginState): Claims {
    let claims: Claims
    try {
        claims = JSON.parse(new TextDecoder().decode(fromBase64url(idToken.split('.')[1] ?? ''))) as Claims
    } catch {
        throw new LoginError('failed')
    }
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (
        !trustedIssuer(env, claims.iss) ||
        !audiences.includes(login.clientId) ||
        (claims.exp ?? 0) < Date.now() / 1000 ||
        claims.nonce !== login.nonce
    ) {
        console.warn('posthog id token rejected', { iss: claims.iss, audOk: audiences.includes(login.clientId), nonceOk: claims.nonce === login.nonce })
        throw new LoginError('failed')
    }
    return claims
}

export async function finishPostHogLogin(env: AppEnv, request: Request): Promise<{ user: User; next: string }> {
    const params = new URL(request.url).searchParams
    const login = await openToken<LoginState>(env.SESSION_SECRET, 'login', readCookie(request, cookieName(env, 'login')))
    if (!login || login.state !== params.get('state')) throw new LoginError('expired')
    if (params.get('error')) throw new LoginError('cancelled')

    const tokenResponse = await fetch(`${oauthHost(env)}/oauth/token/`, {
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
        claims = idTokenClaims(env, tokens.id_token, login)
    } else {
        const userinfo = await fetch(`${oauthHost(env)}/oauth/userinfo/`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        if (!userinfo.ok) throw new LoginError('failed')
        claims = await userinfo.json<Claims>()
    }

    // Anyone can sign up to PostHog with any address, so the email must be verified, not just match.
    if (!claims.email || claims.email_verified !== true || !isAllowedEmail(env, claims.email)) {
        console.warn('posthog sign-in rejected', { hasEmail: !!claims.email, emailVerified: claims.email_verified, claims: Object.keys(claims) })
        throw new LoginError('not_allowed')
    }
    const email = claims.email.toLowerCase()
    if (await isRevoked(env, email)) throw new LoginError('revoked')
    const name = [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email
    return { user: { email, name }, next: login.next }
}
