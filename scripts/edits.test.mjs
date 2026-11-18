// Unit tests for publishing with text edits. Run with `pnpm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EditError, applyEdits } from '../src/lib/edits.ts'

const fails = (content, edits, message) => assert.throws(() => applyEdits(content, edits), (e) => e instanceof EditError && message.test(e.message), String(message))

test('edits apply in order, each to the result of the one before', () => {
    const doc = '<h1>Old</h1><p>one</p>'
    assert.equal(
        applyEdits(doc, [
            { old_text: 'Old', new_text: 'New' },
            { old_text: '<h1>New</h1>', new_text: '<h1>Newer</h1><p>intro</p>' },
            { old_text: '<p>one</p>', new_text: '' },
        ]),
        '<h1>Newer</h1><p>intro</p>'
    )
})

test('replacement text is literal, never a pattern', () => {
    assert.equal(applyEdits('price: X', [{ old_text: 'X', new_text: '$& $1 $$' }]), 'price: $& $1 $$')
})

test('missing, repeated and empty old_text are refused with the edit index', () => {
    fails('abc', [{ old_text: 'zzz', new_text: 'y' }], /^edits\[0\]: old_text was not found/)
    fails('a a', [{ old_text: 'b', new_text: 'b' }, { old_text: 'a', new_text: 'b' }], /^edits\[0\]/)
    // Unique before edits[0] runs, repeated after it: uniqueness is checked against the running result.
    fails('a X', [{ old_text: 'X', new_text: 'a' }, { old_text: 'a', new_text: 'b' }], /^edits\[1\]: old_text occurs more than once/)
    fails('abc', [{ old_text: '', new_text: 'y' }], /^edits\[0\]: old_text is empty/)
})

test('overlapping matches count as repeats', () => {
    fails('aaa', [{ old_text: 'aa', new_text: 'b' }], /more than once/)
})
