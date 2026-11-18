/**
 * Text edits for publishing a new version without resending the whole document. Each old_text must occur exactly
 * once in the document as it stands after the edits before it, so an edit can never land in the wrong place.
 */

export interface TextEdit {
    old_text: string
    new_text: string
}

export class EditError extends Error {}

export function applyEdits(content: string, edits: TextEdit[]): string {
    let result = content
    edits.forEach((edit, n) => {
        const label = `edits[${n}]`
        if (!edit.old_text) throw new EditError(`${label}: old_text is empty`)
        const at = result.indexOf(edit.old_text)
        if (at === -1) throw new EditError(`${label}: old_text was not found in the latest version (after the edits before it)`)
        if (result.indexOf(edit.old_text, at + 1) !== -1) {
            throw new EditError(`${label}: old_text occurs more than once; include more surrounding text so it is unique`)
        }
        result = result.slice(0, at) + edit.new_text + result.slice(at + edit.old_text.length)
    })
    return result
}
