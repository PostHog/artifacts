import type { AppEnv } from './env'
import { randomId } from './lib/crypto'
import type { Answers, Score } from './lib/quiz'
import { StoreError } from './store'

export type TakerKind = 'staff' | 'guest' | 'anonymous'

export interface Taker {
    kind: TakerKind
    /** Lowercased email for staff and guests, a keyed hash of the anonymous browser ID for signed-out takers. */
    id: string
    name: string
}

export interface QuizAttempt {
    id: string
    artifact_id: string
    version: number
    taker_kind: TakerKind
    taker_id: string
    taker_name: string
    attempt_no: number
    points: number
    max_points: number
    percent: number
    passed: number
    /** JSON: Answers. */
    answers: string
    preview: number
    created_at: number
}

/**
 * Ceilings on counted attempts per version, so one artifact's table can't be filled from outside. Signed-out
 * takers have their own, lower ceiling: they can be anyone, so they must not be able to use up the room
 * that signed-in people need.
 */
export const MAX_ATTEMPTS_PER_VERSION: Record<TakerKind, number> = { anonymous: 1000, guest: 5000, staff: 5000 }

export type RecordResult = { ok: true; attempt: QuizAttempt } | { ok: false; reason: 'limit' | 'full' }

/**
 * Stores one submission, or says why not. The person's limit and the version's ceiling are checked inside the
 * same INSERT ... SELECT that numbers the attempt, so two submissions sent at once can't both slip under a
 * limit that a separate count-then-insert would let through. No row written means a limit was reached.
 * The owner's previews skip both limits and are never counted.
 */
export async function recordAttempt(
    env: AppEnv,
    input: { artifactId: string; version: number; taker: Taker; score: Score; answers: Answers; preview: boolean; maxPerTaker: number | null }
): Promise<RecordResult> {
    const id = randomId()
    const now = Date.now()
    const { artifactId, version, taker } = input
    let changes = 0
    try {
        const run = await env.DB.prepare(
            `INSERT INTO quiz_attempts (id, artifact_id, version, taker_kind, taker_id, taker_name, attempt_no, points, max_points, percent, passed, answers, preview, created_at)
             SELECT ?, ?, ?, ?, ?, ?, COALESCE(MAX(attempt_no), 0) + 1, ?, ?, ?, ?, ?, ?, ?
             FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND taker_kind = ? AND taker_id = ?
             HAVING ? = 1 OR (
               (? IS NULL OR COALESCE(SUM(preview = 0), 0) < ?)
               AND (SELECT COUNT(*) FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND taker_kind = ? AND preview = 0) < ?
             )`
        )
            .bind(
                id, artifactId, version, taker.kind, taker.id, taker.name,
                input.score.points, input.score.max, input.score.percent, input.score.passed ? 1 : 0, JSON.stringify(input.answers), input.preview ? 1 : 0, now,
                artifactId, version, taker.kind, taker.id,
                input.preview ? 1 : 0,
                input.maxPerTaker, input.maxPerTaker,
                artifactId, version, taker.kind, MAX_ATTEMPTS_PER_VERSION[taker.kind]
            )
            .run()
        changes = run.meta.changes
    } catch (error) {
        if (String(error).includes('UNIQUE')) throw new StoreError('conflict', 'That submission raced another one')
        throw error
    }
    if (changes === 0) {
        const mine = await env.DB.prepare(
            'SELECT COUNT(*) AS n FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND taker_kind = ? AND taker_id = ? AND preview = 0'
        )
            .bind(artifactId, version, taker.kind, taker.id)
            .first<{ n: number }>()
        return { ok: false, reason: input.maxPerTaker !== null && (mine?.n ?? 0) >= input.maxPerTaker ? 'limit' : 'full' }
    }
    return { ok: true, attempt: (await getAttempt(env, artifactId, id))! }
}

export async function getAttempt(env: AppEnv, artifactId: string, attemptId: string): Promise<QuizAttempt | null> {
    if (!/^[0-9A-Za-z]{22}$/.test(attemptId)) return null
    return env.DB.prepare('SELECT * FROM quiz_attempts WHERE id = ? AND artifact_id = ?').bind(attemptId, artifactId).first<QuizAttempt>()
}

/** One person's own attempts at this artifact, newest first. */
export async function listTakerAttempts(env: AppEnv, artifactId: string, taker: Taker): Promise<QuizAttempt[]> {
    const { results } = await env.DB.prepare(
        'SELECT * FROM quiz_attempts WHERE artifact_id = ? AND taker_kind = ? AND taker_id = ? ORDER BY created_at DESC LIMIT 50'
    )
        .bind(artifactId, taker.kind, taker.id)
        .all<QuizAttempt>()
    return results
}

/** Everyone's counted attempts on one version, newest first, for the owner's results. */
export async function listAttempts(env: AppEnv, artifactId: string, version: number, limit = 500): Promise<QuizAttempt[]> {
    const { results } = await env.DB.prepare(
        'SELECT * FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND preview = 0 ORDER BY created_at DESC LIMIT ?'
    )
        .bind(artifactId, version, Math.min(Math.max(limit, 1), 1000))
        .all<QuizAttempt>()
    return results
}

/** Versions that have counted attempts, newest first, so the results page can offer them. */
export async function attemptVersions(env: AppEnv, artifactId: string): Promise<{ version: number; n: number }[]> {
    const { results } = await env.DB.prepare(
        'SELECT version, COUNT(*) AS n FROM quiz_attempts WHERE artifact_id = ? AND preview = 0 GROUP BY version ORDER BY version DESC'
    )
        .bind(artifactId)
        .all<{ version: number; n: number }>()
    return results
}

export function parseStoredAnswers(attempt: QuizAttempt): Answers {
    try {
        const value = JSON.parse(attempt.answers) as unknown
        return value && typeof value === 'object' ? (value as Answers) : {}
    } catch {
        return {}
    }
}
