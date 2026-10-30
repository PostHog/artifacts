import type { AppEnv, User } from '../env'
import { base64url, fromBase64url, openToken, randomId, sealToken } from './crypto'
import { cookieName, isAllowedEmail, readCookie, serializeCookie } from './session'

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

export class LoginError extends Error {}

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
        logo_uri: `${env.PUBLIC_URL}/favicon.svg`,
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
        throw new LoginError(`Couldn't register with PostHog OAuth (${response.status}).`)
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
            'Set-Cookie': serializeCookie(env, 'login', await sealToken(env.SESSION_SECRET, login, LOGIN_TTL), LOGIN_TTL),
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
}

/**
 * The ID token arrives straight from the token endpoint over TLS, which OIDC Core §3.1.3.7 accepts
 * in place of a signature check. We still bind it to this client, this login (nonce) and its expiry.
 */
function idTokenClaims(idToken: string, login: LoginState): Claims {
    const [, payload] = idToken.split('.')
    if (!payload) throw new LoginError('PostHog returned an invalid ID token.')
    const claims = JSON.parse(new TextDecoder().decode(fromBase64url(payload))) as Claims
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(login.clientId) || (claims.exp ?? 0) < Date.now() / 1000 || claims.nonce !== login.nonce) {
        throw new LoginError('PostHog returned an ID token for a different sign-in. Please try again.')
    }
    return claims
}

export async function finishPostHogLogin(env: AppEnv, request: Request): Promise<{ user: User; next: string }> {
    const params = new URL(request.url).searchParams
    const login = await openToken<LoginState>(env.SESSION_SECRET, readCookie(request, cookieName(env, 'login')))
    if (!login || login.state !== params.get('state')) throw new LoginError('Your sign-in link expired. Please try again.')
    if (params.get('error')) throw new LoginError('PostHog sign-in was cancelled.')

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
        throw new LoginError('PostHog sign-in failed. Please try again.')
    }
    const tokens = await tokenResponse.json<{ access_token: string; id_token?: string }>()

    let claims: Claims
    if (tokens.id_token) {
        claims = idTokenClaims(tokens.id_token, login)
    } else {
        const userinfo = await fetch(`${oauthHost(env)}/oauth/userinfo/`, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        if (!userinfo.ok) throw new LoginError('Could not read your PostHog profile.')
        claims = await userinfo.json<Claims>()
    }

    // Anyone can sign up to PostHog with any address, so the email must be verified, not just match.
    if (!claims.email || claims.email_verified !== true || !isAllowedEmail(env, claims.email)) {
        console.warn('posthog sign-in rejected', { hasEmail: !!claims.email, emailVerified: claims.email_verified, claims: Object.keys(claims) })
        throw new LoginError(`Only verified @${env.ALLOWED_EMAIL_DOMAIN} PostHog accounts can sign in.`)
    }
    const email = claims.email.toLowerCase()
    const name = [claims.given_name, claims.family_name].filter(Boolean).join(' ') || email
    return { user: { email, name }, next: login.next }
}
