import { OAuthProvider } from '@cloudflare/workers-oauth-provider'
import type { AppEnv } from './env'
import { ensureSchema } from './lib/migrate'
import { mcpApiHandler } from './mcp'
import { app } from './web/app'

/**
 * One Worker plays three roles:
 *  - OAuth authorization server for MCP clients (Google sign-in behind /authorize)
 *  - the protected MCP endpoint at /mcp
 *  - the artifact viewer and its sandboxed content routes
 *
 * The provider is built per isolate from env, because the resource URL depends on PUBLIC_URL.
 */
let provider: OAuthProvider<AppEnv> | undefined
let providerFor: string | undefined

function getProvider(env: AppEnv): OAuthProvider<AppEnv> {
    if (!provider || providerFor !== env.PUBLIC_URL) {
        provider = new OAuthProvider<AppEnv>({
            apiRoute: '/mcp',
            apiHandler: mcpApiHandler,
            defaultHandler: { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
            authorizeEndpoint: '/authorize',
            tokenEndpoint: '/oauth/token',
            clientRegistrationEndpoint: '/oauth/register',
            clientIdMetadataDocumentEnabled: true,
            scopesSupported: ['artifacts', 'offline_access'],
            requiredScopes: ['artifacts'],
            resourceMetadata: {
                resource: `${env.PUBLIC_URL}/mcp`,
                authorization_servers: [env.PUBLIC_URL],
                resource_name: 'PostHog Artifacts',
            },
        })
        providerFor = env.PUBLIC_URL
    }
    return provider
}

/** The Worker deploys before anyone has set its secrets; say so instead of failing obscurely. */
function notConfigured(env: AppEnv): Response | null {
    if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return null
    return new Response(
        'PostHog Artifacts is deployed but not configured yet: set the SESSION_SECRET secret (32+ characters, e.g. `openssl rand -hex 32`) under Settings → Variables & Secrets, plus GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for sign-in.',
        { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' } }
    )
}

export default {
    async fetch(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
        const unconfigured = notConfigured(env)
        if (unconfigured) return unconfigured
        // A dedicated content origin only ever serves sandboxed artifact content.
        if (env.CONTENT_URL) {
            const url = new URL(request.url)
            if (url.host === new URL(env.CONTENT_URL).host && url.host !== new URL(env.PUBLIC_URL).host && !url.pathname.startsWith('/c/')) {
                return new Response('Not found', { status: 404 })
            }
        }
        await ensureSchema(env.DB)
        return getProvider(env).fetch(request, env, ctx)
    },
} satisfies ExportedHandler<AppEnv>
