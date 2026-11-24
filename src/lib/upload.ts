import type { Format } from '../env'

export class UploadError extends Error {}

export const FORMATS: readonly Format[] = ['html', 'slides', 'markdown', 'quiz']

const BY_EXTENSION: Record<string, Format> = { html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown', json: 'quiz' }

export const isFormat = (value: unknown): value is Format => FORMATS.includes(value as Format)

const extension = (filename: string) => filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()

/** The format a file name implies, or null when it doesn't (slides are HTML, so they are never guessed). */
export function formatFromFilename(filename: string): Format | null {
    return filename.includes('.') ? (BY_EXTENSION[extension(filename)] ?? null) : null
}

/** "q3-churn_report.html" → "q3 churn report". */
export function titleFromFilename(filename: string): string {
    const base = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename
    return base.replace(/[-_\s]+/g, ' ').trim()
}

/** Artifacts are stored as text, so a binary file is refused instead of being turned into replacement characters. */
export function decodeUpload(bytes: ArrayBuffer): string {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
    } catch {
        throw new UploadError('The file is not UTF-8 text. Upload an HTML, Markdown or quiz JSON file.')
    }
}
