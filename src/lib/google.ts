import type { AppEnv, User } from '../env'
import { base64url, openToken, randomId, sealToken } from './crypto'
import { cookieName, isAllowedEmail, readCookie, serializeCookie } from './session'

const LOGIN_TTL = 600

interface LoginState {
    state: string
    verifier: string
    next: string
}

const redirectUri = (env: AppEnv) => `${env.PUBLIC_URL}/auth/google/callback`

export function googleConfigured(env: AppEnv): boolean {
    return !!env.GOOGLE_CLIENT_ID && !!env.GOOGLE_CLIENT_SECRET
}

/** Starts Google sign-in. State and the PKCE verifier live in a short-lived signed cookie bound to this browser. */
export async function beginGoogleLogin(env: AppEnv, next: string): Promise<Response> {
    const state = randomId(32)
    const verifier = randomId(64)
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri(env),
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        hd: env.ALLOWED_EMAIL_DOMAIN,
        prompt: 'select_account',
    }).toString()
    const cookie = await sealToken(env.SESSION_SECRET, { state, verifier, next } satisfies LoginState, LOGIN_TTL)
    return new Response(null, {
        status: 302,
        headers: { Location: url.toString(), 'Set-Cookie': serializeCookie(env, 'login', cookie, LOGIN_TTL) },
    })
}

export class LoginError extends Error {}

export async function finishGoogleLogin(env: AppEnv, request: Request): Promise<{ user: User; next: string }> {
    const params = new URL(request.url).searchParams
    const saved = await openToken<LoginState>(env.SESSION_SECRET, readCookie(request, cookieName(env, 'login')))
    if (!saved || saved.state !== params.get('state')) throw new LoginError('Your sign-in link expired. Please try again.')
    if (params.get('error')) throw new LoginError('Google sign-in was cancelled.')

    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code: params.get('code') ?? '',
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri(env),
            grant_type: 'authorization_code',
            code_verifier: saved.verifier,
        }),
    })
    if (!tokenResponse.ok) throw new LoginError('Google sign-in failed. Please try again.')
    const { access_token } = await tokenResponse.json<{ access_token: string }>()

    const profileResponse = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
    })
    if (!profileResponse.ok) throw new LoginError('Could not read your Google profile.')
    const profile = await profileResponse.json<{ email?: string; email_verified?: boolean; hd?: string; name?: string }>()

    // `hd` on the authorize URL is only a hint; enforce the domain on the verified profile.
    if (
        !profile.email ||
        !profile.email_verified ||
        profile.hd?.toLowerCase() !== env.ALLOWED_EMAIL_DOMAIN.toLowerCase() ||
        !isAllowedEmail(env, profile.email)
    ) {
        throw new LoginError(`Only @${env.ALLOWED_EMAIL_DOMAIN} accounts can sign in.`)
    }
    return { user: { email: profile.email.toLowerCase(), name: profile.name ?? profile.email }, next: saved.next }
}
