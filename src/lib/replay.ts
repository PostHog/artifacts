import type { AppEnv, User } from '../env'
import { isLocal } from './session'

/**
 * Session replay, recorded into the same PostHog project as the usage events (src/lib/analytics.ts).
 *
 * Two recorders work together:
 *  - posthog-js on our own pages (public/replay.js) records the viewer chrome and is the one that uploads.
 *  - the artifact content runs in a sandboxed, opaque-origin iframe, which the page's recorder can't see into,
 *    so serveContent adds a small script (src/web/replay-frame.ts) that runs PostHog's rrweb recorder inside it.
 *    rrweb's cross-origin iframe support passes its events up to the page's recorder with postMessage, so the
 *    artifact appears in the replay as the viewer saw it. The frame never talks to PostHog itself.
 *
 * Everyone is recorded (staff, invited guests and anonymous link viewers), and artifact text is not masked;
 * only form inputs are, which is posthog-js's default. Set SESSION_REPLAY to "false" to turn it all off.
 */
export interface ReplaySettings {
    token: string
    apiHost: string
    /** Where posthog-js and its recorder are served from. */
    assetsHost: string
}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

export function replaySettings(env: AppEnv): ReplaySettings | null {
    const token = env.POSTHOG_PROJECT_TOKEN
    if (!token || env.SESSION_REPLAY === 'false') return null
    const api = URL.parse(env.POSTHOG_HOST || 'https://us.i.posthog.com')
    if (!api) return null
    // Local runs only send to a local capture host, never to project 2 (same rule as analytics.ts).
    if (isLocal(env) && !LOOPBACK.includes(api.hostname)) return null
    // PostHog Cloud serves assets from a sibling host (us.i.posthog.com → us-assets.i.posthog.com); anything else
    // (a reverse proxy, a local capture host) serves them from /static on the API host, as posthog-js expects.
    const region = /^(us|eu)\.i\.posthog\.com$/.exec(api.hostname)?.[1]
    return { token, apiHost: api.origin, assetsHost: region ? `https://${region}-assets.i.posthog.com` : api.origin }
}

/** What the page's recorder needs to know about the viewer. Never includes a guest's email. */
export async function replayViewer(user: User | null, guest: string | null) {
    if (user) {
        // Same distinct ID as the server-side events, so replays and events line up. A per-identity cookie name
        // keeps a later guest or anonymous session in this browser from reusing a staff member's ID.
        const email = user.email.toLowerCase()
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(email)))
        const hash = [...digest.slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('')
        return { viewer: 'staff' as const, distinct_id: email, persistence_name: `artifacts_${hash}` }
    }
    return { viewer: guest ? ('guest' as const) : ('anonymous' as const), distinct_id: null, persistence_name: 'artifacts_anon' }
}
