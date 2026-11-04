import type { AppEnv, User } from '../env'

/** Where an action came from: an MCP tool call, or the web UI. */
export type Source = 'mcp' | 'web'

type Properties = Record<string, string | number | boolean | null | undefined>

const DEFAULT_HOST = 'https://us.i.posthog.com'

/**
 * Server-side product analytics: who published, shared, viewed and deleted what.
 *
 * Off unless POSTHOG_PROJECT_API_KEY is set, so local dev, the smoke test and forks send nothing.
 * Signed-in people are identified by their @posthog.com email. Signed-out viewers of public links get a
 * throwaway id and no person profile, so outsiders are counted, never profiled.
 *
 * Never sends artifact content, titles, descriptions or version notes, and never sends a viewer's IP
 * (GeoIP is disabled, since the request reaching PostHog comes from Cloudflare, not the viewer).
 *
 * Capture runs after the response via waitUntil and swallows every failure: analytics must never
 * slow down or break a request.
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
    const body = {
        api_key: apiKey,
        event,
        distinct_id: user ? user.email.toLowerCase() : crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        properties: {
            ...properties,
            $lib: 'posthog-artifacts',
            $geoip_disable: true,
            ...(user ? { $set: { email: user.email.toLowerCase(), name: user.name } } : { $process_person_profile: false }),
        },
    }
    const host = (env.POSTHOG_CAPTURE_HOST || DEFAULT_HOST).replace(/\/+$/, '')
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
