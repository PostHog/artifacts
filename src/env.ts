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
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
}

/** Identity of a signed-in PostHog staff member, shared by web sessions and MCP tokens. */
export interface User {
    email: string
    name: string
}

export type Visibility = 'private' | 'public'
export type Format = 'html' | 'markdown'
