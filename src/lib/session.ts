import type { AppEnv, User } from '../env'
import { openToken, sealToken } from './crypto'

// Sessions are stateless, so keep them short-ish; revocation (isRevoked) covers the rest.
const SESSION_TTL = 60 * 60 * 24 * 7

export function isLocal(env: AppEnv): boolean {
    const host = new URL(env.PUBLIC_URL).hostname
    return host === 'localhost' || host === '127.0.0.1'
}

/** `__Host-` cookies require Secure, which browsers only honour on https (and localhost). */
export function cookieName(env: AppEnv, name: string): string {
    return isLocal(env) ? name : `__Host-${name}`
}

export function readCookie(request: Request, name: string): string | undefined {
    const header = request.headers.get('Cookie') ?? ''
    for (const part of header.split(';')) {
        const [key, ...rest] = part.trim().split('=')
        if (key === name) return rest.join('=')
    }
    return undefined
}

export function serializeCookie(env: AppEnv, name: string, value: string, maxAge: number): string {
    const secure = isLocal(env) ? '' : '; Secure'
    return `${cookieName(env, name)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export async function getUser(env: AppEnv, request: Request): Promise<User | null> {
    const session = await openToken<Partial<User>>(env.SESSION_SECRET, 'session', readCookie(request, cookieName(env, 'session')))
    if (!session || typeof session.email !== 'string' || !isAllowedEmail(env, session.email)) return null
    if (await isRevoked(env, session.email)) return null
    return { email: session.email, name: typeof session.name === 'string' ? session.name : session.email }
}

/**
 * Offboarding / incident kill switch: `wrangler kv key put --binding OAUTH_KV --remote revoked:<email> 1`.
 * Checked on every web request and every MCP call, so it cuts off sessions and MCP tokens immediately.
 */
export async function isRevoked(env: AppEnv, email: string): Promise<boolean> {
    return (await env.OAUTH_KV.get(`revoked:${email.toLowerCase()}`)) !== null
}

export async function sessionCookie(env: AppEnv, user: User): Promise<string> {
    return serializeCookie(env, 'session', await sealToken(env.SESSION_SECRET, 'session', user, SESSION_TTL), SESSION_TTL)
}

export function clearSessionCookie(env: AppEnv): string {
    return serializeCookie(env, 'session', '', 0)
}

/**
 * Only allow redirects back to our own origin after login. Resolve against PUBLIC_URL rather than
 * pattern-match, because browsers strip tabs/newlines and treat `\` as `/` (e.g. `/%09/evil.example`).
 */
export function safeNext(env: AppEnv, next: string | null | undefined): string {
    if (!next || !next.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(next)) return '/'
    try {
        const base = new URL(env.PUBLIC_URL)
        const url = new URL(next, base)
        return url.origin === base.origin ? url.pathname + url.search + url.hash : '/'
    } catch {
        return '/'
    }
}

export function isAllowedEmail(env: AppEnv, email: string): boolean {
    const [local, domain, ...rest] = email.toLowerCase().split('@')
    return !!local && rest.length === 0 && domain === env.ALLOWED_EMAIL_DOMAIN.toLowerCase()
}
