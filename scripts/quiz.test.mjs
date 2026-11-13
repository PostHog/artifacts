// Unit tests for the quiz schema and scoring. Run with `pnpm test` (node's built-in runner, no extra dependencies).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { QuizError, parseAnswers, parseQuiz, publicQuiz, questionStats, scoreQuiz } from '../src/lib/quiz.ts'

const base = {
    pass_mark: 60,
    questions: [
        { id: 'q1', type: 'single', prompt: 'Pick b', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['b'], explanation: 'SECRET-EXPLANATION' },
        { id: 'q2', type: 'multi', prompt: 'Pick a and c', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }], correct: ['a', 'c'], points: 2 },
        { id: 'q3', type: 'true_false', prompt: 'True?', correct: ['true'] },
    ],
}
const quiz = () => parseQuiz(JSON.stringify(base))
const bad = (patch, message) => assert.throws(() => parseQuiz(JSON.stringify({ ...base, ...patch })), (e) => e instanceof QuizError && message.test(e.message), String(message))

test('defaults are filled in and true_false gets True/False', () => {
    const q = quiz()
    assert.equal(q.attempts, 1)
    assert.equal(q.show_answers, false)
    assert.equal(q.questions[0].points, 1)
    assert.deepEqual(q.questions[2].options, [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }])
})

test('the public quiz carries no key and no explanations', () => {
    const text = JSON.stringify(publicQuiz(quiz()))
    assert.ok(!text.includes('correct'))
    assert.ok(!text.includes('SECRET-EXPLANATION'))
    assert.ok(!text.includes('explanation'))
})

test('invalid quizzes are refused, by name', () => {
    assert.throws(() => parseQuiz('not json'), /not valid JSON/)
    assert.throws(() => parseQuiz('{}'), /questions/)
    bad({ questions: [{ ...base.questions[0], correct: ['zzz'] }] }, /questions\[0\]\.correct: "zzz" is not one of the options/)
    bad({ questions: [{ ...base.questions[0], correct: ['a', 'b'] }] }, /exactly one correct/)
    bad({ questions: [base.questions[0], base.questions[0]] }, /"q1" is used twice/)
    bad({ questions: [{ ...base.questions[1], correct: ['a', 'b', 'c'] }] }, /every option correct/)
    bad({ questions: [{ ...base.questions[0], options: undefined }] }, /options/)
    bad({ questions: [{ ...base.questions[0], extra: 1 }] }, /extra/)
    bad({ pass_mark: 101 }, /pass_mark/)
    bad({ questions: [] }, /questions/)
})

test('scoring is all-or-nothing per question and weighted', () => {
    const q = quiz()
    const perfect = scoreQuiz(q, { q1: ['b'], q2: ['c', 'a'], q3: ['true'] })
    assert.deepEqual([perfect.points, perfect.max, perfect.percent, perfect.passed], [4, 4, 100, true])
    const partialMulti = scoreQuiz(q, { q1: ['b'], q2: ['a'], q3: ['true'] })
    assert.equal(partialMulti.points, 2, 'a multi question needs exactly the right set')
    assert.equal(partialMulti.questions[1].correct, false)
    const none = scoreQuiz(q, {})
    assert.deepEqual([none.points, none.percent, none.passed], [0, 0, false])
    assert.equal(none.questions[0].answered, false)
})

test('the pass mark compares exactly, not on the rounded percent', () => {
    const q = parseQuiz(JSON.stringify({ ...base, pass_mark: 70, questions: Array.from({ length: 7 }, (_, i) => ({ id: `q${i}`, type: 'single', prompt: 'p', options: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }], correct: ['a'] })) }))
    const answers = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`q${i}`, ['a']]))
    assert.equal(scoreQuiz(q, answers(5)).passed, true)
    const s = scoreQuiz(q, answers(4))
    assert.equal(s.percent, 57)
    assert.equal(s.passed, false)
    const one = (pass_mark) => parseQuiz(JSON.stringify({ ...base, pass_mark, questions: [base.questions[0]] }))
    assert.equal(scoreQuiz(one(100), { q1: ['b'] }).passed, true)
    assert.equal(scoreQuiz(one(100), { q1: ['a'] }).passed, false)
    assert.equal(scoreQuiz(one(0), {}).passed, true, 'a pass mark of 0 always passes')
})

test('submissions the form could not have produced are refused', () => {
    const q = quiz()
    assert.deepEqual(parseAnswers(q, { q1: ['b'], q2: [] }), { q1: ['b'] })
    assert.throws(() => parseAnswers(q, { nope: ['a'] }), /Invalid submission/)
    assert.throws(() => parseAnswers(q, { q1: ['zzz'] }), /Invalid submission/)
    assert.throws(() => parseAnswers(q, { q1: ['a', 'b'] }), /Invalid submission/, 'two picks on a single question')
    assert.deepEqual(parseAnswers(q, { q2: ['a', 'a', 'c'] }), { q2: ['a', 'c'] }, 'repeats collapse')
})

test('per-question stats count right answers and every pick', () => {
    const q = quiz()
    const stats = questionStats(q, [{ q1: ['b'] }, { q1: ['a'] }, { q1: ['a'] }, {}])
    assert.deepEqual(stats[0], { id: 'q1', answered: 3, correct: 1, picks: { a: 2, b: 1 } })
    assert.equal(stats[1].answered, 0)
})
