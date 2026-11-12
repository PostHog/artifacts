import { z } from 'zod'

/**
 * The "quiz" format. A quiz is data, not author HTML: the author sends JSON, we validate it, render it ourselves
 * in the viewer page and score it on the server. That keeps the answer key out of the browser and out of any
 * script, and means a submission is an ordinary same-origin form post.
 *
 * Pure module (no Worker APIs) so the scoring can be unit tested with `node --test`.
 */

export type QuestionType = 'single' | 'multi' | 'true_false'

export interface QuizOption {
    id: string
    text: string
}

export interface QuizQuestion {
    id: string
    type: QuestionType
    prompt: string
    options: QuizOption[]
    /** Option ids. The key: never sent to a taker before they've submitted (see publicQuiz). */
    correct: string[]
    explanation?: string
    points: number
}

export interface Quiz {
    intro?: string
    /** Percent of the points needed to pass. */
    pass_mark: number
    /** Attempts per person per version; null is unlimited. */
    attempts: number | null
    /** Show each question's right answer and explanation on the result. Off by default, so a retake can't copy the key. */
    show_answers: boolean
    questions: QuizQuestion[]
}

export const MAX_QUESTIONS = 50
export const MAX_OPTIONS = 10

export class QuizError extends Error {}

/** What an author (an agent, over MCP) needs to know to write one. Shown in the publish tool's description. */
export const QUIZ_DOCS =
    '"quiz": questions people answer, scored on the server; send JSON, not HTML: { "intro"?: string, "pass_mark"?: 0-100 (default 70), "attempts"?: 1-50 per person per version, or null for unlimited (default 1), "show_answers"?: boolean (default false: takers see only their score, never the key), "questions": [{ "id": "q1" (letters, digits, - _), "type": "single" | "multi" | "true_false", "prompt": string, "options": [{ "id": "a", "text": string }] (2-10; leave out for true_false, which gets True/False with ids "true" and "false"), "correct": ["a"] (exactly one for single and true_false; for multi, the exact set, never all of them), "explanation"?: string (shown only if show_answers), "points"?: 1-100 (default 1) }] } with 1-50 questions. Text is plain; `backticks` make inline code. People are scored all-or-nothing per question. Share it as "team", "invited" or "public"; read the outcome with quiz_results.'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/, 'must be 1-32 letters, digits, "-" or "_"')

const optionSchema = z.object({ id, text: z.string().trim().min(1).max(300) }).strict()

const questionSchema = z
    .object({
        id,
        type: z.enum(['single', 'multi', 'true_false']),
        prompt: z.string().trim().min(1).max(1000),
        // true_false questions may leave this out and get True / False.
        options: z.array(optionSchema).min(2).max(MAX_OPTIONS).optional(),
        correct: z.array(id).min(1).max(MAX_OPTIONS),
        explanation: z.string().trim().max(1000).optional(),
        points: z.number().int().min(1).max(100).default(1),
    })
    .strict()

const quizSchema = z
    .object({
        intro: z.string().trim().max(2000).optional(),
        pass_mark: z.number().int().min(0).max(100).default(70),
        attempts: z.number().int().min(1).max(50).nullable().default(1),
        show_answers: z.boolean().default(false),
        questions: z.array(questionSchema).min(1).max(MAX_QUESTIONS),
    })
    .strict()

const where = (path: PropertyKey[]) => path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${String(p)}`)).join('').replace(/^\./, '') || 'quiz'

/**
 * Parses and checks a quiz. Every problem comes back by name ("questions[2].correct: ..."), so the model that wrote
 * it can fix it from the tool error alone.
 */
export function parseQuiz(text: string): Quiz {
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch {
        throw new QuizError('A quiz must be a JSON object. This content is not valid JSON.')
    }
    const parsed = quizSchema.safeParse(raw)
    if (!parsed.success) {
        const issues = parsed.error.issues.slice(0, 8).map((i) => `${where(i.path)}: ${i.message}`)
        throw new QuizError(`Invalid quiz. ${issues.join('; ')}`)
    }
    const problems: string[] = []
    const seen = new Set<string>()
    const questions: QuizQuestion[] = parsed.data.questions.map((q, n) => {
        const at = `questions[${n}]`
        if (seen.has(q.id)) problems.push(`${at}.id: "${q.id}" is used twice`)
        seen.add(q.id)
        const options =
            q.options ??
            (q.type === 'true_false'
                ? [
                      { id: 'true', text: 'True' },
                      { id: 'false', text: 'False' },
                  ]
                : undefined)
        if (!options) {
            problems.push(`${at}.options: required for ${q.type} questions`)
            return { ...q, options: [] }
        }
        const optionIds = new Set<string>()
        for (const o of options) {
            if (optionIds.has(o.id)) problems.push(`${at}.options: id "${o.id}" is used twice`)
            optionIds.add(o.id)
        }
        if (q.type === 'true_false' && options.length !== 2) problems.push(`${at}.options: a true_false question has exactly two options`)
        const correct = [...new Set(q.correct)]
        if (correct.length !== q.correct.length) problems.push(`${at}.correct: lists an option twice`)
        for (const c of correct) if (!optionIds.has(c)) problems.push(`${at}.correct: "${c}" is not one of the options`)
        if (q.type !== 'multi' && correct.length !== 1) problems.push(`${at}.correct: a ${q.type} question has exactly one correct option`)
        if (q.type === 'multi' && correct.length >= options.length) problems.push(`${at}.correct: a multi question can't have every option correct`)
        return { id: q.id, type: q.type, prompt: q.prompt, options, correct, explanation: q.explanation, points: q.points }
    })
    if (problems.length) throw new QuizError(`Invalid quiz. ${problems.slice(0, 8).join('; ')}`)
    return { intro: parsed.data.intro, pass_mark: parsed.data.pass_mark, attempts: parsed.data.attempts, show_answers: parsed.data.show_answers, questions }
}

/** The quiz as a taker may see it: no key and no explanations. */
export interface PublicQuiz {
    intro?: string
    pass_mark: number
    attempts: number | null
    questions: { id: string; type: QuestionType; prompt: string; options: QuizOption[]; points: number }[]
}

export function publicQuiz(quiz: Quiz): PublicQuiz {
    return {
        intro: quiz.intro,
        pass_mark: quiz.pass_mark,
        attempts: quiz.attempts,
        questions: quiz.questions.map((q) => ({ id: q.id, type: q.type, prompt: q.prompt, options: q.options, points: q.points })),
    }
}

/** Question id → the option ids chosen. A question left out is unanswered. */
export type Answers = Record<string, string[]>

/** Checks a submission against the quiz it was for. Anything the form couldn't have produced is refused. */
export function parseAnswers(quiz: Quiz, raw: Record<string, string[]>): Answers {
    const byId = new Map(quiz.questions.map((q) => [q.id, q]))
    const out: Answers = {}
    for (const [qid, picked] of Object.entries(raw)) {
        const q = byId.get(qid)
        if (!q) throw new QuizError('Invalid submission')
        const chosen = [...new Set(picked)]
        if (chosen.length === 0) continue
        if (q.type !== 'multi' && chosen.length > 1) throw new QuizError('Invalid submission')
        if (!chosen.every((c) => q.options.some((o) => o.id === c))) throw new QuizError('Invalid submission')
        out[qid] = chosen
    }
    return out
}

export interface QuestionResult {
    id: string
    answered: boolean
    correct: boolean
    points: number
}

export interface Score {
    points: number
    max: number
    percent: number
    passed: boolean
    questions: QuestionResult[]
}

/** All or nothing per question: a multi question needs exactly the right set. */
export function scoreQuiz(quiz: Quiz, answers: Answers): Score {
    let points = 0
    let max = 0
    const questions = quiz.questions.map((q): QuestionResult => {
        const chosen = answers[q.id] ?? []
        const correct = chosen.length === q.correct.length && q.correct.every((c) => chosen.includes(c))
        max += q.points
        if (correct) points += q.points
        return { id: q.id, answered: chosen.length > 0, correct, points: correct ? q.points : 0 }
    })
    return {
        points,
        max,
        percent: Math.round((points * 100) / max),
        // Compared exactly, not on the rounded percent, so 69.6% never rounds up into a pass.
        passed: points * 100 >= quiz.pass_mark * max,
        questions,
    }
}

export interface QuestionStats {
    id: string
    answered: number
    correct: number
    /** Option id → how many people picked it. */
    picks: Record<string, number>
}

/** Per-question breakdown over a set of submissions: how many got it right, and what the wrong answers were. */
export function questionStats(quiz: Quiz, submissions: Answers[]): QuestionStats[] {
    return quiz.questions.map((q) => {
        const picks: Record<string, number> = Object.fromEntries(q.options.map((o) => [o.id, 0]))
        let answered = 0
        let correct = 0
        for (const answers of submissions) {
            const chosen = answers[q.id] ?? []
            if (!chosen.length) continue
            answered++
            if (chosen.length === q.correct.length && q.correct.every((c) => chosen.includes(c))) correct++
            for (const c of chosen) if (c in picks) picks[c]!++
        }
        return { id: q.id, answered, correct, picks }
    })
}
