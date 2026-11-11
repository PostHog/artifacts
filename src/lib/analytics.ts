import { PostHog } from 'posthog-node'
import type { AppEnv, User } from '../env'
import { sign } from './crypto'
import { cookieName, isLocal, readCookie, serializeCookie } from './session'

/** Every event this app sends. Add new ones here so names stay static. MCP tool calls go through MCP Analytics (src/mcp.ts). */
export type AnalyticsEvent =
    | 'artifact published'
    | 'artifact visibility changed'
    | 'artifact details updated'
    | 'artifact deleted'
    | 'artifact viewed'
    | 'artifact sent to agent'
    | 'artifacts mcp client connected'
    | 'artifacts user signed in'

type Properties = Record<string, string | number | boolean | null | undefined>

/** Who triggered an event: a staff member, an invited guest (by guestAnalyticsId), or an anonymous browser (by cookie ID). */
export type Actor =
    | { kind: 'staff'; user: User }
    | { kind: 'guest'; id: string }
    | { kind: 'anonymous'; id: string }
    /** An actor resolved earlier and carried in a signed grant, e.g. by the agent handover link. */
    | { kind: 'resolved'; distinctId: string; viewerType: ViewerType }

export type ViewerType = 'staff' | 'guest' | 'anonymous'

/** The distinct_id and viewer_type an actor is sent as. */
export type ViewerActor = Exclude<Actor, { kind: 'resolved' }>

export function actorIdentity(actor: ViewerActor): { distinctId: string; viewerType: ViewerType } {
    if (actor.kind === 'staff') return { distinctId: staffDistinctId(actor.user), viewerType: 'staff' }
    return { distinctId: actor.id, viewerType: actor.kind }
}

/**
 * Staff events use the person's own PostHog distinct_id, so they land on their existing person in project 2.
 * Sessions and MCP grants from before that was looked up fall back to the email.
 */
export const staffDistinctId = (user: User): string => user.distinctId ?? user.email.toLowerCase()

/**
 * Guests are customers, and their emails never go to project 2. This keyed hash still counts each one once
 * across devices, and can't be reversed without SESSION_SECRET.
 */
export async function guestAnalyticsId(env: AppEnv, email: string): Promise<string> {
    return `guest_${(await sign(env.SESSION_SECRET, `analytics.guest.${email.toLowerCase()}`)).slice(0, 32)}`
}

export const APP = 'posthog-artifacts'

const isLoopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(URL.parse(url)?.hostname ?? '')

/** A posthog-node client set up for Workers, or null when analytics are off (no token, or a local run aimed at a real host). */
export function analyticsClient(env: AppEnv, options: { geoip?: boolean } = {}): PostHog | null {
    const token = env.POSTHOG_PROJECT_TOKEN
    const host = env.POSTHOG_HOST || 'https://us.i.posthog.com'
    if (!token) {
        if (isLocal(env)) {
            console.error(
                'POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_PROJECT_TOKEN is configured'
            )
        }
        return null
    }
    // Local runs only send to a local capture host, never to project 2.
    if (isLocal(env) && !isLoopback(host)) return null
    // Setup follows https://posthog.com/docs/libraries/cloudflare-workers: a client per request, no batching.
    return new PostHog(token, { host, flushAt: 1, flushInterval: 0, disableGeoip: !options.geoip })
}

/** The visitor's IP as Cloudflare saw it. Without it, PostHog would see (and geolocate) the Worker's own IP. */
export const clientIp = (request: Request): string | undefined => request.headers.get('CF-Connecting-IP') ?? undefined

// --- Anonymous viewer ID -----------------------------------------------------------

const ANON_COOKIE = 'aid'
const ANON_TTL = 60 * 60 * 24 * 365
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * A stable random ID for a signed-out browser, so unique viewers of a shared artifact can be counted.
 * `setCookie` is the Set-Cookie header to send when the ID is new (or to refresh it), so it survives a year of inactivity.
 */
export function anonymousId(env: AppEnv, request: Request): { id: string; setCookie: string } {
    const existing = readCookie(request, cookieName(env, ANON_COOKIE))
    const id = existing && UUID.test(existing) ? existing : crypto.randomUUID()
    return { id, setCookie: serializeCookie(env, ANON_COOKIE, id, ANON_TTL) }
}

// --- Product events ----------------------------------------------------------------

function actorFields(actor: Actor | User | null): { distinctId: string; properties: Properties } {
    const a: Actor | null = !actor ? null : 'kind' in actor ? actor : { kind: 'staff', user: actor }
    if (a?.kind === 'staff') return { distinctId: staffDistinctId(a.user), properties: { is_signed_in: true, viewer_type: 'staff' } }
    if (a?.kind === 'guest') return { distinctId: a.id, properties: { is_signed_in: true, viewer_type: 'guest' } }
    if (a?.kind === 'anonymous') return { distinctId: a.id, properties: { is_signed_in: false, viewer_type: 'anonymous' } }
    if (a?.kind === 'resolved') return { distinctId: a.distinctId, properties: { is_signed_in: a.viewerType !== 'anonymous', viewer_type: a.viewerType } }
    return { distinctId: crypto.randomUUID(), properties: { is_signed_in: false, viewer_type: 'anonymous' } }
}

/**
 * Sends one product event. `actor` is a staff User, an Actor, or null (unknown). Pass `request` to record the
 * visitor's IP (and so their location) instead of the Worker's.
 */
export function track(
    env: AppEnv,
    ctx: Pick<ExecutionContext, 'waitUntil'>,
    event: AnalyticsEvent,
    actor: Actor | User | null,
    properties: Properties = {},
    request?: Request
): void {
    const ip = request ? clientIp(request) : undefined
    const posthog = analyticsClient(env, { geoip: !!ip })
    if (!posthog) return
    const { distinctId, properties: who } = actorFields(actor)
    ctx.waitUntil(
        posthog
            .captureImmediate({
                // Events attach to the staff member's existing person, but never create or change persons.
                distinctId,
                event,
                properties: { ...properties, ...who, app: APP, $process_person_profile: false, ...(ip ? { $ip: ip } : {}) },
            })
            .catch((error) => console.warn('posthog capture failed', event, String(error)))
            .finally(() => posthog.shutdown())
    )
}
