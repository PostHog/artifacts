import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider'

export interface AppEnv {
    DB: D1Database
    BUCKET: R2Bucket
    OAUTH_KV: KVNamespace
    ASSETS: Fetcher
    OAUTH_PROVIDER: OAuthHelpers
    PUBLIC_URL: string
    CONTENT_URL: string
    ALLOWED_EMAIL_DOMAIN: string
    DEV_LOGIN: string
    SESSION_SECRET: string
    /** PostHog OAuth server and the only ID-token issuer we accept; defaults to US Cloud, https://us.posthog.com. */
    POSTHOG_OAUTH_HOST: string
    /** Comma-separated https hosts MCP clients may redirect to, besides loopback. Default: claude.ai,claude.com */
    MCP_REDIRECT_HOSTS: string
    PUBLISH_LIMITER: RateLimit
    REGISTER_LIMITER: RateLimit
}

/** Identity of a signed-in PostHog staff member, shared by web sessions and MCP tokens. */
export interface User {
    email: string
    name: string
}

export type Visibility = 'private' | 'public'
export type Format = 'html' | 'markdown'
