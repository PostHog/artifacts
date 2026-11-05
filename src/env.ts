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
    /** EU Cloud OAuth host, offered to invited viewers only (staff sign in through US Cloud). Default https://eu.posthog.com */
    POSTHOG_EU_OAUTH_HOST?: string
    /** Comma-separated https hosts MCP clients may redirect to, besides loopback. Default: claude.ai,claude.com */
    MCP_REDIRECT_HOSTS: string
    /** Usage analytics (src/lib/analytics.ts). Empty token = off. */
    POSTHOG_PROJECT_TOKEN?: string
    POSTHOG_HOST?: string
    PUBLISH_LIMITER: RateLimit
    COMMENT_LIMITER: RateLimit
    REGISTER_LIMITER: RateLimit
}

/** Identity of a signed-in PostHog staff member, shared by web sessions and MCP tokens. */
export interface User {
    email: string
    name: string
}

/**
 * private: owner only. team: any signed-in PostHog staff member. invited: people on the artifact's email
 * allowlist who sign in with their own PostHog account. public: anyone with the link.
 */
export type Visibility = 'private' | 'team' | 'invited' | 'public'
/** html: a page. slides: HTML where each <section> in <body> is a 1280×720 slide. markdown: prose. */
export type Format = 'html' | 'slides' | 'markdown'
