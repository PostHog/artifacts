import type { AppEnv, User } from '../env'
import { openToken, sealToken } from './crypto'

const SESSION_TTL = 60 * 60 * 24 * 30

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
    const session = await openToken<User>(env.SESSION_SECRET, readCookie(request, cookieName(env, 'session')))
    return session ? { email: session.email, name: session.name } : null
}

export async function sessionCookie(env: AppEnv, user: User): Promise<string> {
    return serializeCookie(env, 'session', await sealToken(env.SESSION_SECRET, user, SESSION_TTL), SESSION_TTL)
}

export function clearSessionCookie(env: AppEnv): string {
    return serializeCookie(env, 'session', '', 0)
}

/** Only allow same-site relative redirects after login. */
export function safeNext(next: string | null | undefined): string {
    if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return '/'
    return next
}

export function isAllowedEmail(env: AppEnv, email: string): boolean {
    return email.toLowerCase().endsWith(`@${env.ALLOWED_EMAIL_DOMAIN.toLowerCase()}`)
}
