import { PostHog } from 'posthog-node'
import type { AppEnv, User } from '../env'
import { isLocal } from './session'

/** Every event this app sends. Add new ones here so names stay static. */
export type AnalyticsEvent =
    | 'artifact published'
    | 'artifact visibility changed'
    | 'artifact details updated'
    | 'artifact deleted'
    | 'artifact viewed'
    | 'artifacts mcp tool called'
    | 'artifacts mcp client connected'
    | 'artifacts user signed in'

type Properties = Record<string, string | number | boolean | null | undefined>

const isLoopback = (url: string) => ['localhost', '127.0.0.1', '[::1]'].includes(URL.parse(url)?.hostname ?? '')

// Setup follows https://posthog.com/docs/libraries/cloudflare-workers: a client per call, no batching,
// captureImmediate kept alive with waitUntil so the response isn't delayed.
export function track(
    env: AppEnv,
    ctx: Pick<ExecutionContext, 'waitUntil'>,
    event: AnalyticsEvent,
    user: User | null,
    properties: Properties = {}
): void {
    const token = env.POSTHOG_PROJECT_TOKEN
    const host = env.POSTHOG_HOST || 'https://us.i.posthog.com'
    if (!token) {
        if (isLocal(env)) {
            console.error(
                'POSTHOG_PROJECT_TOKEN variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once POSTHOG_PROJECT_TOKEN is configured'
            )
        }
        return
    }
    // Local runs only send to a local capture host, never to project 2.
    if (isLocal(env) && !isLoopback(host)) return

    const posthog = new PostHog(token, { host, flushAt: 1, flushInterval: 0, disableGeoip: true })
    ctx.waitUntil(
        posthog
            .captureImmediate({
                // Staff already have profiles in project 2, so don't create email-keyed duplicates.
                distinctId: user ? user.email.toLowerCase() : crypto.randomUUID(),
                event,
                properties: { ...properties, app: 'posthog-artifacts', is_signed_in: !!user, $process_person_profile: false },
            })
            .catch((error) => console.warn('posthog capture failed', event, String(error)))
            .finally(() => posthog.shutdown())
    )
}
