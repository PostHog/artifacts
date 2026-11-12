import type { AppEnv, Format, User, Visibility } from './env'
import { randomId, sha256Hex } from './lib/crypto'

export const MAX_CONTENT_BYTES = 5 * 1024 * 1024
export const MAX_TITLE_LENGTH = 200

export interface Artifact {
    id: string
    owner_email: string
    owner_name: string | null
    title: string
    description: string | null
    visibility: Visibility
    latest_version: number
    /** 1 when the owner has turned comments on. */
    comments_enabled: number
    created_at: number
    updated_at: number
}

export interface Comment {
    id: string
    artifact_id: string
    version: number
    author_email: string
    author_name: string
    author_kind: 'staff' | 'guest'
    body: string
    /** The passage this comment is about, as a text quote with a little context. All null for a whole-artifact comment. */
    anchor_exact: string | null
    anchor_prefix: string | null
    anchor_suffix: string | null
    created_at: number
}

export interface Version {
    artifact_id: string
    version: number
    format: Format
    size: number
    sha256: string
    object_key: string
    note: string | null
    created_at: number
}

export class StoreError extends Error {
    constructor(
        public code: 'not_found' | 'too_large' | 'invalid' | 'conflict',
        message: string
    ) {
        super(message)
    }
}

// Each version gets a unique object key so concurrent publishes can never overwrite each other's content.
const newObjectKey = (id: string) => `a/${id}/${randomId(16)}`

/** Deletes an uploaded object if the D1 write that would reference it fails, so R2 never accumulates orphans. */
async function withCleanup<T>(env: AppEnv, key: string, write: () => Promise<T>): Promise<T> {
    try {
        return await write()
    } catch (error) {
        await env.BUCKET.delete(key).catch(() => {})
        throw error
    }
}

export function isOwner(artifact: Artifact, user: User | null): boolean {
    return !!user && artifact.owner_email.toLowerCase() === user.email.toLowerCase()
}

// Domain entries ('@acme.com') would let anyone with a free mailbox in, so they're refused for consumer providers.
const CONSUMER_DOMAINS = new Set([
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
    'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'mail.com', 'zoho.com', 'qq.com',
])
export const MAX_INVITES = 50

/** Validates an allowlist: exact emails (`a@acme.com`) or a whole company domain (`@acme.com`). */
export function normalizeInvites(list: string[]): string[] {
    const out = new Set<string>()
    for (const raw of list) {
        const entry = raw.trim().toLowerCase()
        if (!entry) continue
        if (entry.startsWith('@')) {
            if (!/^@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(entry) || entry.length > 255) throw new StoreError('invalid', `"${raw}" is not a valid domain`)
            if (CONSUMER_DOMAINS.has(entry.slice(1))) throw new StoreError('invalid', `${entry} is a consumer email provider; list individual addresses instead`)
        } else if (!/^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']{2,}$/.test(entry) || entry.length > 254) {
            throw new StoreError('invalid', `"${raw}" is not a valid email address`)
        }
        out.add(entry)
    }
    if (out.size > MAX_INVITES) throw new StoreError('invalid', `At most ${MAX_INVITES} entries`)
    return [...out]
}

export async function listInvites(env: AppEnv, id: string): Promise<string[]> {
    const { results } = await env.DB.prepare('SELECT pattern FROM artifact_invites WHERE artifact_id = ? ORDER BY pattern').bind(id).all<{ pattern: string }>()
    return results.map((r) => r.pattern)
}

/** True if `email` is on the artifact's allowlist, by exact address or by its domain. */
export async function isInvited(env: AppEnv, id: string, email: string): Promise<boolean> {
    const lower = email.toLowerCase()
    const domain = lower.split('@')[1]
    if (!domain) return false
    const row = await env.DB.prepare('SELECT 1 AS ok FROM artifact_invites WHERE artifact_id = ? AND pattern IN (?, ?)').bind(id, lower, `@${domain}`).first()
    return !!row
}

function replaceInvitesStatements(env: AppEnv, id: string, patterns: string[]): D1PreparedStatement[] {
    const now = Date.now()
    return [
        env.DB.prepare('DELETE FROM artifact_invites WHERE artifact_id = ?').bind(id),
        ...patterns.map((p) => env.DB.prepare('INSERT INTO artifact_invites (artifact_id, pattern, created_at) VALUES (?, ?, ?)').bind(id, p, now)),
    ]
}

export async function getArtifact(env: AppEnv, id: string): Promise<Artifact | null> {
    if (!/^[0-9A-Za-z]{22}$/.test(id)) return null
    return env.DB.prepare('SELECT * FROM artifacts WHERE id = ?').bind(id).first<Artifact>()
}

/** Returns the artifact only if `user` owns it; otherwise behaves as if it does not exist. */
export async function getOwnedArtifact(env: AppEnv, id: string, user: User): Promise<Artifact> {
    const artifact = await getArtifact(env, id)
    if (!artifact || !isOwner(artifact, user)) throw new StoreError('not_found', `Artifact ${id} not found`)
    return artifact
}

export async function listArtifacts(
    env: AppEnv,
    user: User,
    { limit = 50, before }: { limit?: number; before?: number } = {}
): Promise<Artifact[]> {
    const { results } = await env.DB.prepare(
        'SELECT * FROM artifacts WHERE owner_email = ? AND updated_at < ? ORDER BY updated_at DESC LIMIT ?'
    )
        .bind(user.email.toLowerCase(), before ?? Number.MAX_SAFE_INTEGER, Math.min(Math.max(limit, 1), 200))
        .all<Artifact>()
    return results
}

export async function listVersions(env: AppEnv, id: string, limit = -1): Promise<Version[]> {
    const { results } = await env.DB.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC LIMIT ?')
        .bind(id, limit)
        .all<Version>()
    return results
}

export async function getVersion(env: AppEnv, id: string, version: number): Promise<Version | null> {
    return env.DB.prepare('SELECT * FROM versions WHERE artifact_id = ? AND version = ?').bind(id, version).first<Version>()
}

export async function getContent(env: AppEnv, version: Version): Promise<string | null> {
    const object = await env.BUCKET.get(version.object_key)
    return object ? object.text() : null
}

interface PublishInput {
    artifactId?: string
    title?: string
    description?: string
    content: string
    format: Format
    note?: string
    visibility?: Visibility
    /** Allowlist for visibility 'invited'. Replaces the existing list when given. */
    invited?: string[]
}

/**
 * Creates a new artifact, or appends a version to one the user owns.
 * Versions are immutable: content is written to R2 under a version-specific key before the
 * D1 transaction that makes it the latest, so readers never see a version without content.
 */
export async function publish(env: AppEnv, user: User, input: PublishInput): Promise<{ artifact: Artifact; version: Version }> {
    const bytes = new TextEncoder().encode(input.content)
    if (bytes.byteLength === 0) throw new StoreError('invalid', 'Content is empty')
    if (bytes.byteLength > MAX_CONTENT_BYTES) {
        throw new StoreError('too_large', `Content is ${bytes.byteLength} bytes; the limit is ${MAX_CONTENT_BYTES}`)
    }
    const title = input.title?.trim().slice(0, MAX_TITLE_LENGTH)
    const invites = input.invited ? normalizeInvites(input.invited) : undefined
    if (input.visibility === 'invited' && !invites?.length && !input.artifactId) {
        throw new StoreError('invalid', 'Visibility "invited" needs at least one email or domain in invited_emails')
    }
    const sha256 = await sha256Hex(bytes)
    const now = Date.now()
    const email = user.email.toLowerCase()

    if (!input.artifactId) {
        if (!title) throw new StoreError('invalid', 'A title is required for a new artifact')
        const id = randomId()
        const key = newObjectKey(id)
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: contentTypeFor(input.format) } })
        await withCleanup(env, key, () => env.DB.batch([
            env.DB.prepare(
                `INSERT INTO artifacts (id, owner_email, owner_name, title, description, visibility, latest_version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
            ).bind(id, email, user.name, title, input.description ?? null, input.visibility ?? 'private', now, now),
            env.DB.prepare(
                'INSERT INTO versions (artifact_id, version, format, size, sha256, object_key, note, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
            ).bind(id, input.format, bytes.byteLength, sha256, key, input.note ?? null, now),
            ...(invites ? replaceInvitesStatements(env, id, invites) : []),
        ]))
        return {
            artifact: (await getArtifact(env, id))!,
            version: (await getVersion(env, id, 1))!,
        }
    }

    // Optimistic concurrency: retry if another publish claimed the same version number.
    for (let attempt = 0; attempt < 3; attempt++) {
        const artifact = await getOwnedArtifact(env, input.artifactId, user)
        if (input.visibility === 'invited' && !invites?.length && !(await listInvites(env, artifact.id)).length) {
            throw new StoreError('invalid', 'Visibility "invited" needs at least one email or domain in invited_emails')
        }
        const next = artifact.latest_version + 1
        const key = newObjectKey(artifact.id)
        await env.BUCKET.put(key, bytes, {
            httpMetadata: { contentType: contentTypeFor(input.format) },
        })
        try {
            const [, update] = await env.DB.batch([
                env.DB.prepare(
                    'INSERT INTO versions (artifact_id, version, format, size, sha256, object_key, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(artifact.id, next, input.format, bytes.byteLength, sha256, key, input.note ?? null, now),
                env.DB.prepare(
                    `UPDATE artifacts SET latest_version = ?, updated_at = ?,
                       title = COALESCE(?, title), description = COALESCE(?, description), visibility = COALESCE(?, visibility)
                     WHERE id = ? AND latest_version = ?`
                ).bind(next, now, title || null, input.description ?? null, input.visibility ?? null, artifact.id, artifact.latest_version),
            ])
            if (update?.meta.changes === 1) {
                if (invites) await env.DB.batch(replaceInvitesStatements(env, artifact.id, invites))
                return {
                    artifact: (await getArtifact(env, artifact.id))!,
                    version: (await getVersion(env, artifact.id, next))!,
                }
            }
        } catch (error) {
            if (!String(error).includes('UNIQUE') && !String(error).includes('PRIMARY KEY')) {
                await env.BUCKET.delete(key).catch(() => {})
                throw error
            }
        }
        // Lost the race: this attempt's object was never referenced, so remove it.
        await env.BUCKET.delete(key)
    }
    throw new StoreError('conflict', 'The artifact was updated concurrently; please retry')
}

/**
 * `invited` replaces the allowlist when given. Switching to 'invited' needs a non-empty list, either passed
 * now or kept from earlier. The list survives a switch away so toggling back doesn't lose it.
 */
export async function setVisibility(env: AppEnv, user: User, id: string, visibility: Visibility, invited?: string[]): Promise<Artifact> {
    await getOwnedArtifact(env, id, user)
    const invites = invited ? normalizeInvites(invited) : undefined
    if (visibility === 'invited' && !invites?.length && !(await listInvites(env, id)).length) {
        throw new StoreError('invalid', 'Add at least one email address or domain to share with specific people')
    }
    await env.DB.batch([
        ...(invites ? replaceInvitesStatements(env, id, invites) : []),
        env.DB.prepare('UPDATE artifacts SET visibility = ? WHERE id = ?').bind(visibility, id),
    ])
    return (await getArtifact(env, id))!
}

export async function updateMetadata(
    env: AppEnv,
    user: User,
    id: string,
    { title, description }: { title?: string; description?: string }
): Promise<Artifact> {
    await getOwnedArtifact(env, id, user)
    const trimmed = title?.trim().slice(0, MAX_TITLE_LENGTH)
    await env.DB.prepare('UPDATE artifacts SET title = COALESCE(?, title), description = COALESCE(?, description), updated_at = ? WHERE id = ?')
        .bind(trimmed || null, description ?? null, Date.now(), id)
        .run()
    return (await getArtifact(env, id))!
}

// --- Comments ----------------------------------------------------------------------

export const MAX_COMMENT_LENGTH = 2000
export const MAX_COMMENTS_PER_ARTIFACT = 500

/** Who is commenting: a signed-in PostHog user, or an invited viewer. */
export interface Commenter {
    email: string
    name: string
    kind: 'staff' | 'guest'
}

export const MAX_ANCHOR_LENGTH = 500
export const MAX_ANCHOR_CONTEXT = 64

export interface Anchor {
    exact: string
    prefix: string
    suffix: string
}

/** Plain text, no control characters beyond newline and tab. Returns null when there is no usable selection. */
export function cleanAnchor(input?: { exact?: string; prefix?: string; suffix?: string }): Anchor | null {
    const strip = (value: string | undefined) => (value ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    const exact = strip(input?.exact).trim()
    if (!exact) return null
    if (exact.length > MAX_ANCHOR_LENGTH) throw new StoreError('invalid', 'anchor')
    return { exact, prefix: strip(input?.prefix).slice(-MAX_ANCHOR_CONTEXT), suffix: strip(input?.suffix).slice(0, MAX_ANCHOR_CONTEXT) }
}

export async function listComments(env: AppEnv, id: string): Promise<Comment[]> {
    const { results } = await env.DB.prepare('SELECT * FROM comments WHERE artifact_id = ? ORDER BY created_at ASC LIMIT ?')
        .bind(id, MAX_COMMENTS_PER_ARTIFACT)
        .all<Comment>()
    return results
}

export async function countComments(env: AppEnv, id: string): Promise<number> {
    return (await env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE artifact_id = ?').bind(id).first<{ n: number }>())?.n ?? 0
}

/** Stored as plain text and only ever rendered escaped. The caller has already decided this person may comment. */
export async function addComment(env: AppEnv, artifact: Artifact, author: Commenter, body: string, anchor: Anchor | null = null): Promise<Comment> {
    const text = body.replace(/\r\n/g, '\n').trim()
    if (!text) throw new StoreError('invalid', 'Write something first')
    if (text.length > MAX_COMMENT_LENGTH) throw new StoreError('too_large', `Comments are limited to ${MAX_COMMENT_LENGTH} characters`)
    if ((await countComments(env, artifact.id)) >= MAX_COMMENTS_PER_ARTIFACT) throw new StoreError('too_large', 'This artifact has reached its comment limit')
    const comment: Comment = {
        id: randomId(),
        artifact_id: artifact.id,
        version: artifact.latest_version,
        author_email: author.email.toLowerCase(),
        author_name: author.name.slice(0, 100),
        author_kind: author.kind,
        body: text,
        anchor_exact: anchor?.exact ?? null,
        anchor_prefix: anchor?.prefix ?? null,
        anchor_suffix: anchor?.suffix ?? null,
        created_at: Date.now(),
    }
    await env.DB.prepare(
        'INSERT INTO comments (id, artifact_id, version, author_email, author_name, author_kind, body, anchor_exact, anchor_prefix, anchor_suffix, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    )
        .bind(comment.id, comment.artifact_id, comment.version, comment.author_email, comment.author_name, comment.author_kind, comment.body, comment.anchor_exact, comment.anchor_prefix, comment.anchor_suffix, comment.created_at)
        .run()
    return comment
}

/** The author can delete their own comment, and the artifact's owner can delete any. Returns whether a row was removed. */
export async function deleteComment(env: AppEnv, artifact: Artifact, commentId: string, actor: { email: string; kind: 'staff' | 'guest'; owner: boolean }): Promise<boolean> {
    const comment = await env.DB.prepare('SELECT * FROM comments WHERE id = ? AND artifact_id = ?').bind(commentId, artifact.id).first<Comment>()
    if (!comment) return false
    const isAuthor = comment.author_kind === actor.kind && comment.author_email === actor.email.toLowerCase()
    if (!isAuthor && !actor.owner) return false
    await env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(commentId).run()
    return true
}

export async function setCommentsEnabled(env: AppEnv, user: User, id: string, enabled: boolean): Promise<Artifact> {
    await getOwnedArtifact(env, id, user)
    await env.DB.prepare('UPDATE artifacts SET comments_enabled = ? WHERE id = ?').bind(enabled ? 1 : 0, id).run()
    return (await getArtifact(env, id))!
}

export async function deleteArtifact(env: AppEnv, user: User, id: string): Promise<void> {
    await getOwnedArtifact(env, id, user)
    const keys = (await listVersions(env, id)).map((v) => v.object_key)
    await env.DB.batch([
        env.DB.prepare('DELETE FROM versions WHERE artifact_id = ?').bind(id),
        env.DB.prepare('DELETE FROM artifact_invites WHERE artifact_id = ?').bind(id),
        env.DB.prepare('DELETE FROM comments WHERE artifact_id = ?').bind(id),
        env.DB.prepare('DELETE FROM artifact_views WHERE artifact_id = ?').bind(id),
        env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
    ])
    if (keys.length) await env.BUCKET.delete(keys)
}

// --- Views (the owner's view counter) ----------------------------------------------

/** Who viewed an artifact. Staff and guests by email; anonymous browsers by their analytics cookie ID. */
export type Viewer =
    | { kind: 'staff'; email: string; name: string }
    | { kind: 'guest'; email: string }
    | { kind: 'anonymous'; id: string }

export interface ViewRow {
    viewer_kind: 'staff' | 'guest' | 'anonymous'
    email: string | null
    name: string | null
    views: number
    first_viewed_at: number
    last_viewed_at: number
    last_version: number
}

export interface ViewStats {
    total: number
    unique: number
    /** Named viewers (staff and guests), most recent first. Anonymous viewers are only counted. */
    viewers: ViewRow[]
    anonymous: { viewers: number; views: number }
}

/** Records one view by someone other than the owner (callers skip the owner). */
export async function recordView(env: AppEnv, artifactId: string, version: number, viewer: Viewer): Promise<void> {
    const now = Date.now()
    const key = viewer.kind === 'anonymous' ? `anon:${viewer.id}` : viewer.email.toLowerCase()
    const email = viewer.kind === 'anonymous' ? null : viewer.email.toLowerCase()
    const name = viewer.kind === 'staff' ? viewer.name : null
    await env.DB.prepare(
        `INSERT INTO artifact_views (artifact_id, viewer_key, viewer_kind, email, name, views, first_viewed_at, last_viewed_at, last_version)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
         ON CONFLICT (artifact_id, viewer_key) DO UPDATE SET
           views = views + 1, last_viewed_at = excluded.last_viewed_at, last_version = excluded.last_version,
           viewer_kind = excluded.viewer_kind, name = COALESCE(excluded.name, name)`
    )
        .bind(artifactId, key, viewer.kind, email, name, now, now, version)
        .run()
}

/** View counts for the owner. Reads at most `limit` named viewers. */
export async function viewStats(env: AppEnv, artifactId: string, limit = 200): Promise<ViewStats> {
    const [totals, named] = await env.DB.batch([
        env.DB.prepare(
            `SELECT COALESCE(SUM(views), 0) AS total, COUNT(*) AS uniq,
                    COALESCE(SUM(CASE WHEN viewer_kind = 'anonymous' THEN views END), 0) AS anon_views,
                    COUNT(CASE WHEN viewer_kind = 'anonymous' THEN 1 END) AS anon_viewers
             FROM artifact_views WHERE artifact_id = ?`
        ).bind(artifactId),
        env.DB.prepare(
            `SELECT viewer_kind, email, name, views, first_viewed_at, last_viewed_at, last_version FROM artifact_views
             WHERE artifact_id = ? AND viewer_kind != 'anonymous' ORDER BY last_viewed_at DESC LIMIT ?`
        ).bind(artifactId, limit),
    ])
    const t = (totals!.results[0] ?? {}) as { total?: number; uniq?: number; anon_views?: number; anon_viewers?: number }
    return {
        total: t.total ?? 0,
        unique: t.uniq ?? 0,
        viewers: named!.results as unknown as ViewRow[],
        anonymous: { viewers: t.anon_viewers ?? 0, views: t.anon_views ?? 0 },
    }
}

export function contentTypeFor(format: Format): string {
    return format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8'
}

export function shareUrl(env: AppEnv, id: string): string {
    return `${env.PUBLIC_URL}/a/${id}`
}
