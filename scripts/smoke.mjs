// End-to-end smoke test against a local `pnpm dev` server (DEV_LOGIN must be enabled).
// Walks the real MCP OAuth flow (DCR → consent → PKCE token), drives the MCP tools, and checks viewer access rules.
// Usage: node scripts/smoke.mjs [baseUrl]
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'

const BASE = process.argv[2] ?? 'http://localhost:8787'
const b64url = (buf) => buf.toString('base64url')

class Jar {
    cookies = new Map()
    store(response) {
        for (const header of response.headers.getSetCookie()) {
            const [pair] = header.split(';')
            const [name, ...value] = pair.split('=')
            this.cookies.set(name.trim(), value.join('='))
        }
    }
    header() {
        return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
    }
}

async function request(jar, path, init = {}) {
    const response = await fetch(new URL(path, BASE), {
        redirect: 'manual',
        ...init,
        headers: { ...(jar ? { Cookie: jar.header() } : {}), ...init.headers },
    })
    jar?.store(response)
    return response
}

const step = (name) => console.log(`✓ ${name}`)

// 1. Sign in (dev login)
const owner = new Jar()
let res = await request(owner, '/login/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ email: 'smoke@posthog.com', name: 'Smoke Test', next: '/' }),
})
assert.equal(res.status, 302)
assert.ok(owner.cookies.has('session'), 'session cookie set')
step('dev login')

const outsider = new Jar()
res = await request(outsider, '/login/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ email: 'evil@example.com', next: '/' }),
})
assert.ok(!outsider.cookies.has('session'), 'non-posthog emails are rejected')
await request(outsider, '/login/dev', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ email: 'other@posthog.com', next: '/' }),
})
step('domain restriction')

// 2. MCP endpoint demands OAuth
res = await request(null, '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
assert.equal(res.status, 401)
assert.match(res.headers.get('WWW-Authenticate') ?? '', /resource_metadata/)
step('unauthenticated /mcp → 401 with resource metadata')

// 3. Dynamic client registration
const redirectUri = 'http://localhost:9999/callback'
res = await request(null, '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Smoke', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
})
assert.equal(res.status, 201, await res.clone().text())
const { client_id } = await res.json()
step('dynamic client registration')

// 4. Authorize + consent
const verifier = b64url(randomBytes(32))
const challenge = b64url(createHash('sha256').update(verifier).digest())
const authorize = new URL('/authorize', BASE)
authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirectUri,
    scope: 'artifacts',
    state: 'xyz',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${BASE}/mcp`,
}).toString()
res = await request(owner, authorize.pathname + authorize.search)
assert.equal(res.status, 200, `consent page: ${res.status} ${await res.clone().text()}`)
const page = await res.text()
const handle = page.match(/name="handle" value="([^"]+)"/)?.[1]
assert.ok(handle, 'consent handle present')
res = await request(owner, '/authorize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE },
    body: new URLSearchParams({ handle, scope: 'artifacts', decision: 'approve' }),
})
assert.equal(res.status, 302, await res.clone().text())
const callback = new URL(res.headers.get('Location'))
assert.equal(callback.searchParams.get('state'), 'xyz')
const code = callback.searchParams.get('code')
assert.ok(code)
step('consent + authorization code')

// 5. Token
res = await request(null, '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id,
        code_verifier: verifier,
        resource: `${BASE}/mcp`,
    }),
})
assert.equal(res.status, 200, await res.clone().text())
const { access_token } = await res.json()
step('token exchange')

// 6. MCP calls
let rpcId = 0
async function mcp(method, params) {
    const response = await request(null, '/mcp', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${access_token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
    })
    const text = await response.text()
    assert.equal(response.status, 200, `${method}: ${response.status} ${text}`)
    const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(text.split('\n').find((l) => l.startsWith('data:')).slice(5))
    assert.ok(!json.error, `${method}: ${JSON.stringify(json.error)}`)
    return json.result
}
const call = async (name, args) => {
    const result = await mcp('tools/call', { name, arguments: args })
    assert.ok(!result.isError, `${name}: ${result.content?.[0]?.text}`)
    return result.structuredContent ?? JSON.parse(result.content[0].text)
}

const init = await mcp('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smoke', version: '1' },
})
assert.equal(init.serverInfo.name, 'posthog-artifacts')
const { tools } = await mcp('tools/list', {})
assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['delete_artifact', 'get_artifact', 'list_artifacts', 'publish_artifact', 'set_visibility', 'update_artifact']
)
step(`MCP initialize + tools/list (${tools.length} tools)`)

const v1 = await call('publish_artifact', {
    title: 'Smoke report',
    description: 'A test',
    format: 'html',
    content: '<!doctype html><h1>Version one</h1><script>document.body.append(" js ok")</script>',
})
assert.equal(v1.visibility, 'private')
assert.equal(v1.latest_version, 1)
assert.match(v1.id, /^[0-9A-Za-z]{22}$/)
const id = v1.id
step(`publish v1 → ${v1.url}`)

const v2 = await call('publish_artifact', { artifact_id: id, format: 'markdown', content: '# Version two\n\n| a | b |\n|---|---|\n| 1 | 2 |', note: 'Switch to markdown' })
assert.equal(v2.latest_version, 2)
assert.equal(v2.title, 'Smoke report')
step('publish v2 (new version keeps title)')

// Near the 5 MB limit, with quotes that double in size when JSON-escaped
const big = await call('publish_artifact', { title: 'Big', format: 'html', content: '<p class="x">"quoted"</p>'.repeat(180_000) })
await call('delete_artifact', { artifact_id: big.id })
step('publish near the 5 MB limit fits the MCP request size limit')

const listed = await call('list_artifacts', {})
assert.ok(listed.artifacts.some((a) => a.id === id))
const got = await call('get_artifact', { artifact_id: id, version: 1, include_content: true })
assert.equal(got.versions.length, 2)
assert.match(got.content, /Version one/)
step('list + get (with v1 content)')

// 7. Viewer access rules
const anon = new Jar()
const other = outsider // signed in as other@posthog.com
const view = async (jar, path) => request(jar, path)
// Browsers mark iframe loads; the content route only serves those.
const frame = async (jar, path) => request(jar, path, { headers: { 'Sec-Fetch-Dest': 'iframe' } })
const frameOf = async (r) => (await r.text()).match(/<iframe src="([^"]+)"/)?.[1]?.replaceAll('&amp;', '&')

res = await view(anon, `/a/${id}`)
assert.equal(res.status, 302, 'anonymous user is sent to login for private artifacts')
res = await view(other, `/a/${id}`)
assert.equal(res.status, 404, 'other staff cannot see a private artifact')
res = await view(owner, `/a/${id}`)
assert.equal(res.status, 200)
const ownerFrame = await frameOf(res)
res = await frame(owner, ownerFrame)
assert.equal(res.status, 200)
assert.match(res.headers.get('Content-Security-Policy'), /sandbox allow-scripts/)
assert.match(await res.text(), /<h1[^>]*>Version two<\/h1>/)
res = await view(owner, `/a/${id}?v=1`)
assert.equal(res.status, 200)
assert.match(await res.clone().text(), /You're viewing version 1/)
step('private: owner only (others 404, anonymous → login)')

// Content never renders top-level (phishing on our domain, or abuse as e.g. an OAuth metadata doc)
res = await view(owner, ownerFrame)
assert.equal(res.status, 403, 'top-level content load refused')
res = await view(owner, `/a/${id}`)
assert.match(res.headers.get('Content-Security-Policy') ?? '', /script-src 'self'/)
assert.equal(res.headers.get('Cross-Origin-Opener-Policy'), 'same-origin')
step('content is iframe-only; viewer sends CSP + COOP')

// Tampered frame token is rejected
res = await frame(anon, ownerFrame.replace(/t=[^&]+/, 't=forged.token'))
assert.equal(res.status, 403)
step('forged content token rejected')

// Team sharing: any signed-in staff member can view; signed-out visitors can't tell it exists
await call('set_visibility', { artifact_id: id, visibility: 'team' })
res = await view(anon, `/a/${id}`)
assert.equal(res.status, 302, 'signed-out visitors are sent to sign in for team artifacts')
res = await view(other, `/a/${id}`)
assert.equal(res.status, 200, 'other staff can see a team artifact')
const teamHtml = await res.clone().text()
assert.ok(!teamHtml.includes('data-share-form'), 'no share controls for team viewers')
assert.ok(!teamHtml.includes('og:title'), 'team artifacts are never unfurled')
const teamFrame = await frameOf(res)
res = await frame(other, teamFrame)
assert.equal(res.status, 200)
res = await view(other, `/a/${id}?v=1`)
assert.equal(res.status, 302, 'old versions are not shared with the team')
res = await view(owner, `/a/${id}`)
assert.match(await res.text(), /pill team/, 'owner sees the team pill')
res = await request(owner, `/a/${id}/visibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ visibility: 'private' }),
})
assert.equal(res.status, 200)
res = await frame(other, teamFrame)
assert.equal(res.status, 404, 'unsharing revokes outstanding team frame grants')
res = await view(other, `/a/${id}`)
assert.equal(res.status, 404)
step('team: signed-in staff only, latest version only, revocable')

// Share via the web UI endpoint (as the browser would)
res = await request(owner, `/a/${id}/visibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ visibility: 'public' }),
})
assert.equal(res.status, 200)
res = await request(owner, `/a/${id}/visibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ visibility: 'private' }),
})
assert.equal(res.status, 403, 'cross-origin share change rejected')
res = await request(other, `/a/${id}/visibility`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ visibility: 'private' }),
})
assert.equal(res.status, 404, 'non-owner cannot change sharing')
step('share toggle (owner only, same-origin only)')

res = await view(anon, `/a/${id}`)
assert.equal(res.status, 200, 'public artifact visible anonymously')
const publicHtml = await res.clone().text()
assert.ok(!publicHtml.includes('data-share-form'), 'no share controls for viewers')
assert.ok(!publicHtml.includes('Version history'), 'no version history for viewers')
assert.match(publicHtml, /og:title/)
const publicFrame = await frameOf(res)
res = await frame(anon, publicFrame)
assert.equal(res.status, 200)
res = await view(anon, `/a/${id}?v=1`)
assert.equal(res.status, 302, 'old versions are not shared')
res = await frame(anon, `/c/${id}/1?t=x`)
assert.equal(res.status, 403)
step('public: latest version only, no management UI')

// Publishing a new version invalidates outstanding public frame grants for the old one
await call('publish_artifact', { artifact_id: id, format: 'html', content: '<h1>Version three</h1>' })
res = await frame(anon, publicFrame)
assert.equal(res.status, 404, 'superseded version no longer served via public grant')
// Unsharing revokes immediately
res = await view(anon, `/a/${id}`)
const latestFrame = await frameOf(res)
await call('set_visibility', { artifact_id: id, visibility: 'private' })
res = await frame(anon, latestFrame)
assert.equal(res.status, 404, 'unsharing revokes outstanding public frame grants')
res = await view(anon, `/a/${id}`)
assert.equal(res.status, 302)
step('unsharing and new versions revoke public access immediately')

// MCP ownership checks: a second user's token can't touch this artifact (simulated via unknown id)
const missing = await mcp('tools/call', { name: 'set_visibility', arguments: { artifact_id: 'A'.repeat(22), visibility: 'public' } })
assert.ok(missing.isError)
step('MCP errors are tool errors, not protocol errors')

await call('update_artifact', { artifact_id: id, title: 'Renamed smoke report' })
await call('delete_artifact', { artifact_id: id })
res = await view(owner, `/a/${id}`)
assert.equal(res.status, 404)
step('rename + delete')

// --- Invited viewers (customers): allowlist + their own PostHog account -------------
// The real sign-in goes through PostHog, so the smoke test uses the local-only /login/dev-guest stand-in,
// which sets the same guest cookie the OAuth callback does for any address.
const form = (jar, path, fields, headers = {}) =>
    request(jar, path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, ...headers }, body: new URLSearchParams(fields) })
const guestLogin = async (email) => {
    const jar = new Jar()
    res = await form(jar, '/login/dev-guest', { email })
    assert.equal(res.status, 302)
    assert.ok(jar.cookies.get('guest'), 'guest cookie set')
    return jar
}

let r = await mcp('tools/call', { name: 'publish_artifact', arguments: { title: 'No list', format: 'html', content: '<p>x</p>', visibility: 'invited' } })
assert.ok(r.isError, 'invited needs a list')
const inv = await call('publish_artifact', {
    title: 'Customer doc',
    format: 'html',
    content: '<!doctype html><h1>For Acme</h1>',
    visibility: 'invited',
    invited_emails: ['ana@acme.com', '@globex.com', 'ANA@acme.com'],
})
assert.equal(inv.visibility, 'invited')
assert.deepEqual([...inv.invited_emails].sort(), ['@globex.com', 'ana@acme.com'], 'list is normalised and de-duplicated')
r = await mcp('tools/call', { name: 'set_visibility', arguments: { artifact_id: inv.id, visibility: 'invited', invited_emails: ['@gmail.com'] } })
assert.ok(r.isError, 'consumer domains cannot be allowlisted')
r = await mcp('tools/call', { name: 'set_visibility', arguments: { artifact_id: inv.id, visibility: 'invited', invited_emails: ['not an email'] } })
assert.ok(r.isError, 'malformed entries are refused')
step('invited: owner sets an allowlist; consumer domains and junk are refused')

// The gate looks the same to everyone and says nothing about the artifact.
for (const jar of [anon, other]) {
    res = await view(jar, `/a/${inv.id}`)
    assert.equal(res.status, 200)
    const gate = await res.text()
    assert.match(gate, /Sign in to view this document/)
    assert.match(gate, new RegExp(`/a/${inv.id}/signin/eu`))
    assert.ok(!gate.includes('Customer doc') && !gate.includes('<iframe') && !gate.includes('og:title'), 'gate leaks nothing')
}
res = await view(anon, `/a/${inv.id}/signin/mars`)
assert.equal(res.status, 404, 'unknown region refused')
step('invited: gate shows nothing about the artifact (anonymous or signed-in staff)')

// Signed in as a PostHog user who is NOT on the list: same gate, no access.
const stranger = await guestLogin('stranger@example.com')
res = await view(stranger, `/a/${inv.id}`)
assert.match(await res.text(), /Sign in to view this document/, 'a PostHog account alone is not enough')
res = await frame(stranger, `/c/${inv.id}/1?t=forged`)
assert.equal(res.status, 403)
step('invited: having a PostHog account is not access; the allowlist decides')

// Exact address.
const ana = await guestLogin('ana@acme.com')
res = await view(ana, `/a/${inv.id}`)
assert.equal(res.status, 200)
const guestHtml = await res.text()
assert.ok(!guestHtml.includes('data-share-form') && !guestHtml.includes('Version history'), 'no management UI for guests')
assert.ok(!guestHtml.includes('og:title'), 'invited artifacts are never unfurled')
const guestFrame = await frameOf(await view(ana, `/a/${inv.id}`))
res = await frame(ana, guestFrame)
assert.equal(res.status, 200)
assert.match(await res.text(), /For Acme/)
res = await view(ana, `/a/${inv.id}?v=1`)
assert.equal(res.status, 200, 'latest version still served')
step('invited: allowlisted address → access, latest version only')

// A guest is not a staff user.
res = await request(ana, '/')
assert.match(await res.text(), /Sign in with PostHog/, 'guest cookie is not a staff session')
const asSession = new Jar()
asSession.cookies.set('session', ana.cookies.get('guest'))
res = await request(asSession, '/')
assert.match(await res.text(), /Sign in with PostHog/, 'guest token cannot be replayed as a session')
res = await request(ana, `/a/${id}/visibility`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: BASE }, body: JSON.stringify({ visibility: 'public' }) })
assert.equal(res.status, 401, 'guests cannot manage sharing')
const other2 = await call('publish_artifact', { title: 'Other invited', format: 'html', content: '<h1>Other</h1>', visibility: 'invited', invited_emails: ['someone@else.com'] })
res = await view(ana, `/a/${other2.id}`)
assert.match(await res.text(), /Sign in to view this document/, 'allowlists are per artifact')
await call('delete_artifact', { artifact_id: other2.id })
step('invited: guests are not staff; allowlists are per artifact')

// Domain entry: anyone at globex.com, but not lookalikes.
const bob = await guestLogin('bob@globex.com')
res = await view(bob, `/a/${inv.id}`)
assert.equal(res.status, 200, 'domain entries admit people at that domain')
for (const email of ['eve@evilglobex.com', 'eve@globex.com.evil.example', 'eve@sub.globex.com']) {
    const jar = await guestLogin(email)
    res = await view(jar, `/a/${inv.id}`)
    assert.match(await res.text(), /Sign in to view this document/, `${email} is not on the list`)
}
step('invited: @domain entries match the domain exactly')

// Allowlist edits and unsharing take effect on open grants immediately.
await call('set_visibility', { artifact_id: inv.id, visibility: 'invited', invited_emails: ['@globex.com'] })
res = await frame(ana, guestFrame)
assert.equal(res.status, 404, 'removing an address revokes their open frame grant')
res = await view(ana, `/a/${inv.id}`)
assert.match(await res.text(), /Sign in to view this document/, 'and sends them back to the gate')
res = await view(bob, `/a/${inv.id}`)
assert.equal(res.status, 200, 'others on the list are unaffected')
const bobFrame = await frameOf(await view(bob, `/a/${inv.id}`))
await call('publish_artifact', { artifact_id: inv.id, format: 'html', content: '<h1>For Acme v2</h1>' })
res = await frame(bob, bobFrame)
assert.equal(res.status, 404, 'a new version supersedes open grants')
const bobFrame2 = await frameOf(await view(bob, `/a/${inv.id}`))
await call('set_visibility', { artifact_id: inv.id, visibility: 'private' })
res = await frame(bob, bobFrame2)
assert.equal(res.status, 404, 'unsharing revokes open grants')
res = await view(bob, `/a/${inv.id}`)
assert.equal(res.status, 302, 'private again: indistinguishable from missing')
await call('set_visibility', { artifact_id: inv.id, visibility: 'invited' })
res = await view(bob, `/a/${inv.id}`)
assert.equal(res.status, 200, 'the list survives a switch away and back')
res = await request(bob, `/a/${inv.id}/signout`, { method: 'POST', headers: { Origin: BASE } })
res = await view(bob, `/a/${inv.id}`)
assert.match(await res.text(), /Sign in to view this document/, 'sign out ends the guest session')
await call('delete_artifact', { artifact_id: inv.id })
step('invited: allowlist edits, new versions, unsharing and sign-out all take effect immediately')

// --- Security regressions ---------------------------------------------------
// Open redirect: browsers strip tabs, so /<TAB>/evil.example would become //evil.example
res = await request(owner, '/login?next=/%09/evil.example')
assert.equal(res.headers.get('Location'), '/', 'tab-smuggled next is neutralised')
res = await request(owner, '/login?next=/a/xyz%3Fv%3D1')
assert.equal(res.headers.get('Location'), '/a/xyz?v=1', 'same-origin next still works')
step('safeNext rejects control-character redirects')

// A token minted for one purpose can't be replayed as another (frame grant → session)
const frameToken = decodeURIComponent(new URL(publicFrame, BASE).searchParams.get('t'))
const forged = new Jar()
forged.cookies.set('session', frameToken)
res = await request(forged, '/')
assert.equal(res.status, 200)
assert.match(await res.text(), /Sign in with PostHog/, 'frame token is not a session')
step('tokens are purpose-bound')

res = await request(null, '/login?error=Email%20it-help%40evil.example%20now')
assert.ok(!(await res.text()).includes('evil.example'), 'arbitrary error text is not reflected')
res = await request(null, '/login?error=expired')
assert.match(await res.text(), /sign-in link expired/)
step('login errors are codes, not reflected text')

res = await request(null, '/oauth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude Code', redirect_uris: ['https://evil.example/cb'], token_endpoint_auth_method: 'none' }),
})
assert.equal(res.status, 400, 'non-allowlisted redirect URIs cannot register')
step('DCR restricted to loopback / allowed MCP hosts')

res = await request(owner, '/logout')
assert.equal(res.status, 404, 'logout is POST-only')
res = await request(anon, '/a/' + 'B'.repeat(22))
assert.equal(res.status, 302, 'missing artifacts look like private ones to signed-out visitors')
step('logout CSRF + existence oracle closed')

// Revocation cuts off web sessions and MCP tokens immediately
const kv = (...args) => execFileSync('pnpm', ['exec', 'wrangler', 'kv', 'key', ...args, '--binding', 'OAUTH_KV', '--local'], { stdio: 'ignore' })
kv('put', 'revoked:smoke@posthog.com', '1')
try {
    res = await request(owner, '/')
    assert.match(await res.text(), /Sign in with PostHog/, 'revoked session is signed out')
    res = await request(null, '/mcp', {
        method: 'POST',
        headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'tools/list', params: {} }),
    })
    assert.equal(res.status, 403, 'revoked MCP token refused')
} finally {
    kv('delete', 'revoked:smoke@posthog.com')
}
res = await request(owner, '/')
assert.match(await res.text(), /Your artifacts/, 'access restored after un-revoking')
step('revocation kill switch (web + MCP)')

console.log('\nAll smoke checks passed.')
