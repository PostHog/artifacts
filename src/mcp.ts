import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { z } from 'zod'
import type { AppEnv, User } from './env'
import { isAllowedEmail, isRevoked } from './lib/session'
import {
    type Artifact,
    MAX_CONTENT_BYTES,
    StoreError,
    type Version,
    deleteArtifact,
    getContent,
    getOwnedArtifact,
    getVersion,
    listArtifacts,
    listVersions,
    publish,
    setVisibility,
    shareUrl,
    updateMetadata,
} from './store'

const INSTRUCTIONS = `PostHog Artifacts hosts finished content (reports, write-ups, HTML pages, Markdown docs) at artifacts.posthog.com.
Every artifact has an unguessable link. New artifacts are private (only the owner can see them) unless published with visibility "public", which makes the latest version viewable by anyone with the link.
Publishing again with an artifact_id adds a new version; only the latest version is ever shared. Prefer updating an existing artifact over creating duplicates.`

const artifactId = z.string().regex(/^[0-9A-Za-z]{22}$/).describe('The artifact ID (the last part of its URL)')
const visibility = z
    .enum(['private', 'public'])
    .describe('"private": only you can view it. "public": anyone with the link can view the latest version.')

function describe(env: AppEnv, artifact: Artifact) {
    return {
        id: artifact.id,
        url: shareUrl(env, artifact.id),
        title: artifact.title,
        description: artifact.description,
        visibility: artifact.visibility,
        latest_version: artifact.latest_version,
        created_at: new Date(artifact.created_at).toISOString(),
        updated_at: new Date(artifact.updated_at).toISOString(),
    }
}

function describeVersion(version: Version) {
    return {
        version: version.version,
        format: version.format,
        size: version.size,
        note: version.note,
        created_at: new Date(version.created_at).toISOString(),
    }
}

function ok(value: object) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> }
}

function fail(error: unknown) {
    const message = error instanceof StoreError ? error.message : 'Something went wrong. Please try again.'
    if (!(error instanceof StoreError)) console.error('mcp tool error', error)
    return { content: [{ type: 'text' as const, text: message }], isError: true }
}

/** Wraps a tool body so store errors become MCP tool errors instead of protocol failures. */
function guarded<A>(fn: (args: A) => Promise<object>) {
    return async (args: A) => {
        try {
            return ok(await fn(args))
        } catch (error) {
            return fail(error)
        }
    }
}

export function buildServer(env: AppEnv, user: User): McpServer {
    const server = new McpServer({ name: 'posthog-artifacts', version: '1.0.0' }, { instructions: INSTRUCTIONS })

    server.registerTool(
        'publish_artifact',
        {
            title: 'Publish artifact',
            description: `Publish HTML or Markdown content as a hosted artifact and get its link. Omit artifact_id to create a new artifact (private by default); pass artifact_id to publish a new version of one you own. Content must be self-contained (inline CSS/JS, or assets from public CDNs) and at most ${MAX_CONTENT_BYTES / 1024 / 1024} MB.`,
            inputSchema: z.object({
                content: z.string().min(1).describe('The full HTML document or Markdown text'),
                format: z.enum(['html', 'markdown']).describe('How to render the content'),
                title: z.string().max(200).optional().describe('Required when creating; updates the title when given for a new version'),
                description: z.string().max(1000).optional().describe('One-sentence summary shown in link previews'),
                artifact_id: artifactId.optional(),
                note: z.string().max(500).optional().describe('What changed in this version'),
                visibility: visibility.optional(),
            }),
            annotations: { destructiveHint: false, idempotentHint: false },
        },
        guarded(async (args) => {
            const { success } = await env.PUBLISH_LIMITER.limit({ key: user.email })
            if (!success) throw new StoreError('invalid', 'Too many publishes in the last minute; wait a moment and retry')
            const { artifact, version } = await publish(env, user, {
                artifactId: args.artifact_id,
                title: args.title,
                description: args.description,
                content: args.content,
                format: args.format,
                note: args.note,
                visibility: args.visibility,
            })
            return { ...describe(env, artifact), version: describeVersion(version) }
        })
    )

    server.registerTool(
        'list_artifacts',
        {
            title: 'List my artifacts',
            description: 'List artifacts you own, most recently updated first.',
            inputSchema: z.object({
                limit: z.number().int().min(1).max(200).optional(),
                updated_before: z.string().datetime().optional().describe('Pagination cursor: updated_at of the last item seen'),
            }),
            annotations: { readOnlyHint: true },
        },
        guarded(async ({ limit, updated_before }) => {
            const artifacts = await listArtifacts(env, user, {
                limit,
                before: updated_before ? Date.parse(updated_before) : undefined,
            })
            return { artifacts: artifacts.map((a) => describe(env, a)) }
        })
    )

    server.registerTool(
        'get_artifact',
        {
            title: 'Get artifact',
            description: 'Get an artifact you own: metadata, version history, and optionally the content of one version (latest by default).',
            inputSchema: z.object({
                artifact_id: artifactId,
                version: z.number().int().min(1).optional(),
                include_content: z.boolean().optional().describe('Include the raw content (default false)'),
            }),
            annotations: { readOnlyHint: true },
        },
        guarded(async ({ artifact_id, version, include_content }) => {
            const artifact = await getOwnedArtifact(env, artifact_id, user)
            const versions = await listVersions(env, artifact.id)
            let content: string | undefined
            if (include_content) {
                const selected = await getVersion(env, artifact.id, version ?? artifact.latest_version)
                if (!selected) throw new StoreError('not_found', `Version ${version} not found`)
                content = (await getContent(env, selected)) ?? undefined
            }
            return { ...describe(env, artifact), versions: versions.map(describeVersion), content }
        })
    )

    server.registerTool(
        'set_visibility',
        {
            title: 'Share or unshare artifact',
            description:
                'Change who can view an artifact. "public" makes the latest version viewable by anyone with the link; "private" restricts it to you. Older versions are never shared.',
            inputSchema: z.object({ artifact_id: artifactId, visibility }),
            annotations: { idempotentHint: true },
        },
        guarded(async ({ artifact_id, visibility }) => describe(env, await setVisibility(env, user, artifact_id, visibility)))
    )

    server.registerTool(
        'update_artifact',
        {
            title: 'Rename artifact',
            description: "Change an artifact's title or description without publishing a new version.",
            inputSchema: z.object({
                artifact_id: artifactId,
                title: z.string().min(1).max(200).optional(),
                description: z.string().max(1000).optional(),
            }),
            annotations: { idempotentHint: true },
        },
        guarded(async ({ artifact_id, title, description }) =>
            describe(env, await updateMetadata(env, user, artifact_id, { title, description }))
        )
    )

    server.registerTool(
        'delete_artifact',
        {
            title: 'Delete artifact',
            description: 'Permanently delete an artifact and all of its versions. The link stops working for everyone. Cannot be undone.',
            inputSchema: z.object({ artifact_id: artifactId }),
            annotations: { destructiveHint: true },
        },
        guarded(async ({ artifact_id }) => {
            await deleteArtifact(env, user, artifact_id)
            return { deleted: artifact_id }
        })
    )

    return server
}

/** OAuthProvider's API handler: `ctx.props` holds the identity stored by completeAuthorization(). */
export const mcpApiHandler = {
    async fetch(request: Request, env: AppEnv, ctx: ExecutionContext) {
        const props = (ctx.props ?? {}) as Partial<User>
        // Grants are only ever minted for allowed users, but re-check: the domain policy may tighten
        // and revoked users (offboarding, incidents) must lose MCP access without waiting for token expiry.
        if (typeof props.email !== 'string' || !isAllowedEmail(env, props.email) || (await isRevoked(env, props.email))) {
            return Response.json({ error: 'access_revoked' }, { status: 403 })
        }
        const user: User = { email: props.email, name: typeof props.name === 'string' ? props.name : props.email }
        const handler = createMcpHandler(() => buildServer(env, user), { route: '/mcp', maxRequestBodySize: MAX_REQUEST_BYTES })

        // agents' protocol-era check and legacy (2025-era) handler both read the body with the SDK's 4 MB
        // default, ignoring maxRequestBodySize, which breaks publishing anything near MAX_CONTENT_BYTES.
        // Read and bound the body ourselves and hand it over parsed, so nothing downstream re-reads it.
        if (request.method !== 'POST') return handler.fetch(request)
        if (Number(request.headers.get('Content-Length') ?? 0) > MAX_REQUEST_BYTES) return tooLarge()
        const text = await request.text()
        if (new TextEncoder().encode(text).byteLength > MAX_REQUEST_BYTES) return tooLarge()
        let parsedBody: unknown
        try {
            parsedBody = JSON.parse(text)
        } catch {
            parsedBody = undefined
        }
        const replay = new Request(request, { body: text })
        return handler.fetch(replay, parsedBody === undefined ? undefined : { parsedBody })
    },
}

// Room for a MAX_CONTENT_BYTES artifact after JSON string escaping (worst case ~2x) plus the envelope.
const MAX_REQUEST_BYTES = MAX_CONTENT_BYTES * 2 + 64 * 1024

const tooLarge = () =>
    Response.json(
        { jsonrpc: '2.0', id: null, error: { code: -32000, message: `Request body exceeds ${MAX_REQUEST_BYTES} bytes` } },
        { status: 413 }
    )
