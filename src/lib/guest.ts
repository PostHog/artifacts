import type { AppEnv } from '../env'
import { openToken, sealToken } from './crypto'
import { cookieName, isRevoked, readCookie, serializeCookie } from './session'

/**
 * Invited viewers sign in with their own PostHog account (US or EU Cloud) and are admitted only if their
 * verified email is on the artifact's allowlist. They get a `guest` cookie that is a different cookie and
 * token purpose from a staff session, so a guest can never act as a signed-in PostHog staff user.
 */
const GUEST_TTL = 60 * 60 * 24 * 7

export const normalizeEmail = (value: string): string | null => {
    const email = value.trim().toLowerCase()
    return email.length <= 254 && /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']{2,}$/.test(email) ? email : null
}

/** A signed-in invited viewer. `distinctId` is their PostHog ID when they're staff (see LoginResult), for analytics only. */
export interface Guest {
    email: string
    distinctId?: string
}

export async function getGuestIdentity(env: AppEnv, request: Request): Promise<Guest | null> {
    const token = await openToken<{ email?: string; distinctId?: string }>(env.SESSION_SECRET, 'guest', readCookie(request, cookieName(env, 'guest')))
    const email = typeof token?.email === 'string' ? normalizeEmail(token.email) : null
    if (!email || (await isRevoked(env, email))) return null
    return typeof token?.distinctId === 'string' ? { email, distinctId: token.distinctId } : { email }
}

export async function getGuest(env: AppEnv, request: Request): Promise<string | null> {
    return (await getGuestIdentity(env, request))?.email ?? null
}

export async function guestCookie(env: AppEnv, email: string, distinctId?: string): Promise<string> {
    const value = distinctId ? { email, distinctId } : { email }
    return serializeCookie(env, 'guest', await sealToken(env.SESSION_SECRET, 'guest', value, GUEST_TTL), GUEST_TTL)
}

export const clearGuestCookie = (env: AppEnv) => serializeCookie(env, 'guest', '', 0)
