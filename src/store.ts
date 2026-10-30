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
    created_at: number
    updated_at: number
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

export function isOwner(artifact: Artifact, user: User | null): boolean {
    return !!user && artifact.owner_email.toLowerCase() === user.email.toLowerCase()
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

export async function listVersions(env: AppEnv, id: string): Promise<Version[]> {
    const { results } = await env.DB.prepare('SELECT * FROM versions WHERE artifact_id = ? ORDER BY version DESC')
        .bind(id)
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
    const sha256 = await sha256Hex(bytes)
    const now = Date.now()
    const email = user.email.toLowerCase()

    if (!input.artifactId) {
        if (!title) throw new StoreError('invalid', 'A title is required for a new artifact')
        const id = randomId()
        const key = newObjectKey(id)
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: contentTypeFor(input.format) } })
        await env.DB.batch([
            env.DB.prepare(
                `INSERT INTO artifacts (id, owner_email, owner_name, title, description, visibility, latest_version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
            ).bind(id, email, user.name, title, input.description ?? null, input.visibility ?? 'private', now, now),
            env.DB.prepare(
                'INSERT INTO versions (artifact_id, version, format, size, sha256, object_key, note, created_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)'
            ).bind(id, input.format, bytes.byteLength, sha256, key, input.note ?? null, now),
        ])
        return {
            artifact: (await getArtifact(env, id))!,
            version: (await getVersion(env, id, 1))!,
        }
    }

    // Optimistic concurrency: retry if another publish claimed the same version number.
    for (let attempt = 0; attempt < 3; attempt++) {
        const artifact = await getOwnedArtifact(env, input.artifactId, user)
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
                return {
                    artifact: (await getArtifact(env, artifact.id))!,
                    version: (await getVersion(env, artifact.id, next))!,
                }
            }
        } catch (error) {
            if (!String(error).includes('UNIQUE') && !String(error).includes('PRIMARY KEY')) throw error
        }
        // Lost the race: this attempt's object was never referenced, so remove it.
        await env.BUCKET.delete(key)
    }
    throw new StoreError('conflict', 'The artifact was updated concurrently; please retry')
}

export async function setVisibility(env: AppEnv, user: User, id: string, visibility: Visibility): Promise<Artifact> {
    await getOwnedArtifact(env, id, user)
    await env.DB.prepare('UPDATE artifacts SET visibility = ? WHERE id = ?').bind(visibility, id).run()
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

export async function deleteArtifact(env: AppEnv, user: User, id: string): Promise<void> {
    await getOwnedArtifact(env, id, user)
    const keys = (await listVersions(env, id)).map((v) => v.object_key)
    await env.DB.batch([
        env.DB.prepare('DELETE FROM versions WHERE artifact_id = ?').bind(id),
        env.DB.prepare('DELETE FROM artifacts WHERE id = ?').bind(id),
    ])
    if (keys.length) await env.BUCKET.delete(keys)
}

export function contentTypeFor(format: Format): string {
    return format === 'markdown' ? 'text/markdown; charset=utf-8' : 'text/html; charset=utf-8'
}

export function shareUrl(env: AppEnv, id: string): string {
    return `${env.PUBLIC_URL}/a/${id}`
}
