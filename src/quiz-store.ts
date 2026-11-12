import type { AppEnv } from './env'
import { randomId } from './lib/crypto'
import type { Answers, Score } from './lib/quiz'
import { StoreError } from './store'

export type TakerKind = 'staff' | 'guest' | 'anonymous'

export interface Taker {
    kind: TakerKind
    /** Lowercased email for staff and guests, the anonymous browser ID for signed-out takers. */
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

/** A ceiling on what signed-out takers of a public quiz can write into one artifact. */
export const MAX_ATTEMPTS_PER_ARTIFACT = 5000

export async function countAttempts(env: AppEnv, artifactId: string): Promise<number> {
    return (await env.DB.prepare('SELECT COUNT(*) AS n FROM quiz_attempts WHERE artifact_id = ? AND preview = 0').bind(artifactId).first<{ n: number }>())?.n ?? 0
}

/** Attempts that count against this person's limit on this version. The owner's previews never do. */
export async function countTakerAttempts(env: AppEnv, artifactId: string, version: number, taker: Taker): Promise<number> {
    return (
        (
            await env.DB.prepare(
                'SELECT COUNT(*) AS n FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND taker_kind = ? AND taker_id = ? AND preview = 0'
            )
                .bind(artifactId, version, taker.kind, taker.id)
                .first<{ n: number }>()
        )?.n ?? 0
    )
}

/**
 * Stores one submission. The next attempt number is worked out in the same statement that inserts it, and the
 * table's unique key makes a second submission that raced for the same number fail instead of slipping past a limit.
 */
export async function recordAttempt(
    env: AppEnv,
    input: { artifactId: string; version: number; taker: Taker; score: Score; answers: Answers; preview: boolean }
): Promise<QuizAttempt> {
    const id = randomId()
    const now = Date.now()
    try {
        await env.DB.prepare(
            `INSERT INTO quiz_attempts (id, artifact_id, version, taker_kind, taker_id, taker_name, attempt_no, points, max_points, percent, passed, answers, preview, created_at)
             VALUES (?, ?, ?, ?, ?, ?,
               (SELECT COALESCE(MAX(attempt_no), 0) + 1 FROM quiz_attempts WHERE artifact_id = ? AND version = ? AND taker_kind = ? AND taker_id = ?),
               ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(
                id, input.artifactId, input.version, input.taker.kind, input.taker.id, input.taker.name,
                input.artifactId, input.version, input.taker.kind, input.taker.id,
                input.score.points, input.score.max, input.score.percent, input.score.passed ? 1 : 0, JSON.stringify(input.answers), input.preview ? 1 : 0, now
            )
            .run()
    } catch (error) {
        if (String(error).includes('UNIQUE')) throw new StoreError('conflict', 'That submission raced another one')
        throw error
    }
    return (await getAttempt(env, input.artifactId, id))!
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
