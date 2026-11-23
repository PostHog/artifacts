// Unit tests for MCP OAuth redirect URI policy and CSP form-action. Run with `pnpm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isAllowedRedirectUri, pageCsp } from '../src/lib/policy.ts'

const env = {
    MCP_REDIRECT_HOSTS: 'claude.ai,claude.com',
    MCP_REDIRECT_URIS: 'https://antigravity.google/oauth-callback',
}

test('allows exact https callback URI in MCP_REDIRECT_URIS', () => {
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google/oauth-callback'), true)
    assert.equal(isAllowedRedirectUri(env, 'https://ANTIGRAVITY.GOOGLE/oauth-callback'), true)
})

test('rejects other paths, queries, schemes, and host tricks on MCP_REDIRECT_URIS hosts', () => {
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google/other'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google/oauth-callback/extra'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google/oauth-callback?foo=bar'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google/oauth-callback#frag'), false)
    assert.equal(isAllowedRedirectUri(env, 'http://antigravity.google/oauth-callback'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://antigravity.google./oauth-callback'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://evil.antigravity.google/oauth-callback'), false)
    assert.equal(isAllowedRedirectUri(env, 'https://user@antigravity.google/oauth-callback'), false)
})

test('ignores malformed or non-https entries in MCP_REDIRECT_URIS', () => {
    const messy = {
        MCP_REDIRECT_HOSTS: 'claude.ai',
        MCP_REDIRECT_URIS: 'not-a-url, http://antigravity.google/oauth-callback, https://antigravity.google/oauth-callback?q=1',
    }
    assert.equal(isAllowedRedirectUri(messy, 'http://antigravity.google/oauth-callback'), false)
    assert.equal(isAllowedRedirectUri(messy, 'https://antigravity.google/oauth-callback?q=1'), false)
    assert.equal(isAllowedRedirectUri(messy, 'https://antigravity.google/oauth-callback'), false)
})

test('preserves loopback and MCP_REDIRECT_HOSTS behaviour', () => {
    assert.equal(isAllowedRedirectUri(env, 'http://localhost:8080/callback'), true)
    assert.equal(isAllowedRedirectUri(env, 'http://127.0.0.1:4321/cb'), true)
    assert.equal(isAllowedRedirectUri(env, 'https://claude.ai/api/mcp/auth_callback'), true)
    assert.equal(isAllowedRedirectUri(env, 'https://evil.example/callback'), false)
})

test('includes exact redirect URIs in pageCsp form-action', () => {
    const csp = pageCsp(env, 'https://artifacts.posthog.com')
    const formAction = csp.split('; ').find((d) => d.startsWith('form-action '))
    assert.ok(formAction, 'form-action directive present')
    assert.ok(formAction.includes('https://antigravity.google/oauth-callback'), formAction)
    assert.ok(formAction.includes('https://claude.ai'), formAction)
})
