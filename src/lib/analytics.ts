import type { AppEnv, User } from '../env'
import { isLocal } from './session'

/** Where an action came from: an MCP tool call, or the web UI. */
export type Source = 'mcp' | 'web'

type Properties = Record<string, string | number | boolean | null | undefined>

const DEFAULT_HOST = 'https://us.i.posthog.com'

const isLoopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(URL.parse(url)?.hostname ?? '')

/**
 * Server-side product analytics: who published, shared, viewed and deleted what.
 * Events go to PostHog's own project (project 2, see wrangler.jsonc), so they share it with the
 * PostHog app's events: every event carries `$lib: posthog-artifacts` to filter on.
 *
 * - Off when POSTHOG_PROJECT_API_KEY is empty. A localhost deployment (`pnpm dev`, the smoke test)
 *   only ever sends to a localhost capture host, so local runs can't pollute production data.
 * - Signed-in people are keyed by their @posthog.com email. No person profiles are created: staff
 *   already have profiles in project 2 under their app distinct_id, and duplicates would muddy them.
 *   Signed-out viewers of public links get a throwaway id.
 * - Never sends artifact content, titles, descriptions or version notes, and never sends a viewer's
 *   IP (GeoIP is disabled, since the request reaching PostHog comes from Cloudflare, not the viewer).
 * - Capture runs after the response via waitUntil and swallows every failure: analytics must never
 *   slow down or break a request.
 */
export function track(
    env: AppEnv,
    ctx: Pick<ExecutionContext, 'waitUntil'>,
    event: string,
    user: User | null,
    properties: Properties = {}
): void {
    const apiKey = env.POSTHOG_PROJECT_API_KEY
    if (!apiKey) return
    const host = (env.POSTHOG_CAPTURE_HOST || DEFAULT_HOST).replace(/\/+$/, '')
    if (isLocal(env) && !isLoopback(host)) return
    const body = {
        api_key: apiKey,
        event,
        distinct_id: user ? user.email.toLowerCase() : crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        properties: {
            ...properties,
            signed_in: !!user,
            $lib: 'posthog-artifacts',
            $geoip_disable: true,
            $process_person_profile: false,
        },
    }
    ctx.waitUntil(
        fetch(`${host}/i/v0/e/`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
            .then((response) => {
                if (!response.ok) console.warn('posthog capture failed', event, response.status)
            })
            .catch((error) => console.warn('posthog capture failed', event, String(error)))
    )
}
