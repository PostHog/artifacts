// Unit tests for uploading a file through the web UI. Run with `pnpm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UploadError, decodeUpload, formatFromFilename, titleFromFilename } from '../src/lib/upload.ts'

test('the format comes from the extension, case-insensitively', () => {
    assert.equal(formatFromFilename('report.html'), 'html')
    assert.equal(formatFromFilename('Report.HTM'), 'html')
    assert.equal(formatFromFilename('notes.md'), 'markdown')
    assert.equal(formatFromFilename('quiz.json'), 'quiz')
})

test('unknown or missing extensions give no format', () => {
    assert.equal(formatFromFilename('photo.png'), null)
    assert.equal(formatFromFilename('README'), null)
    assert.equal(formatFromFilename('html'), null)
})

test('the title comes from the file name', () => {
    assert.equal(titleFromFilename('q3-churn_report.html'), 'q3 churn report')
    assert.equal(titleFromFilename('notes.v2.md'), 'notes.v2')
    assert.equal(titleFromFilename('README'), 'README')
})

test('text decodes, a BOM is dropped, and binary is refused', () => {
    assert.equal(decodeUpload(new TextEncoder().encode('﻿# Hi ✓').buffer), '# Hi ✓')
    assert.throws(() => decodeUpload(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]).buffer), UploadError)
})
