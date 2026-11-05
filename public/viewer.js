// Viewer chrome: popovers, share toggle and copy-link. The artifact itself runs in a sandboxed iframe.
;(() => {
    const toast = document.querySelector('.toast')
    const notify = (message) => {
        if (!toast) return
        toast.textContent = message
        toast.classList.add('show')
        clearTimeout(notify.timer)
        notify.timer = setTimeout(() => toast.classList.remove('show'), 1800)
    }

    // Close popovers on outside click / Escape, and keep only one open.
    const pops = [...document.querySelectorAll('details[data-close-outside]')]
    document.addEventListener('click', (event) => {
        for (const pop of pops) if (!pop.contains(event.target)) pop.open = false
    })
    // Clicks inside the artifact iframe never reach this document; the window blurs instead.
    window.addEventListener('blur', () => {
        for (const pop of pops) pop.open = false
    })
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') for (const pop of pops) pop.open = false
    })

    const form = document.querySelector('[data-share-form]')
    const link = document.querySelector('[data-share-link]')
    const copy = document.querySelector('[data-copy]')
    let pill = document.querySelector('[data-visibility-pill]')

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(link.value)
            notify('Link copied')
        } catch {
            link.select()
            notify('Press ⌘C to copy')
        }
    }

    let current = form?.querySelector('input:checked')?.value
    const inviteBox = form?.querySelector('[data-invite-box]')
    const inviteList = form?.querySelector('[data-invite-list]')

    // Applies a visibility change. `invited` (an array) only accompanies "Specific people".
    const apply = async (visibility, invited) => {
        const inputs = [...form.querySelectorAll('input, textarea, button')]
        inputs.forEach((input) => (input.disabled = true))
        try {
            const response = await fetch(`/a/${form.dataset.artifact}/visibility`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(invited ? { visibility, invited } : { visibility }),
            })
            if (!response.ok) throw new Error(await response.text())
            const saved = await response.json()
            if (inviteList && saved.invited) inviteList.value = saved.invited.join('\n')
            const shared = visibility !== 'private'
            link.disabled = !shared
            copy.disabled = !shared
            // The server renders every pill variant into <template>s; swap in the matching one.
            const template = document.querySelector(`template[data-pill="${visibility}"]`)
            if (pill && template) {
                const next = template.content.firstElementChild.cloneNode(true)
                pill.replaceWith(next)
                pill = next
            }
            current = visibility
            if (inviteBox) inviteBox.hidden = visibility !== 'invited'
            if (shared) await copyLink()
            else notify('Only you can view this now')
        } catch (error) {
            form.querySelector(`input[value="${current}"]`).checked = true
            if (inviteBox) inviteBox.hidden = current !== 'invited'
            notify(String(error?.message || '').length < 120 && error?.message ? error.message : "Couldn't update sharing. Try again.")
        } finally {
            inputs.forEach((input) => (input.disabled = false))
        }
    }

    form?.addEventListener('change', (event) => {
        if (event.target.name !== 'visibility') return
        // "Specific people" needs a list first: reveal the box and wait for Save.
        if (event.target.value === 'invited') {
            inviteBox.hidden = false
            inviteList.focus()
            return
        }
        apply(event.target.value)
    })
    form?.querySelector('[data-invite-save]')?.addEventListener('click', () => {
        const invited = inviteList.value.split(/[\s,;]+/).filter(Boolean)
        if (!invited.length) return notify('Add at least one email or domain')
        apply('invited', invited)
    })
    copy?.addEventListener('click', copyLink)

    // Decks navigate with the arrow keys, which only reach the iframe once it has focus.
    const deck = document.querySelector('iframe[data-autofocus]')
    deck?.addEventListener('load', () => deck.focus())

    document.querySelector('[data-fullscreen]')?.addEventListener('click', () => {
        document.querySelector('.viewer iframe')?.requestFullscreen?.().catch(() => {})
    })
})()
