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
    const pill = document.querySelector('[data-visibility-pill]')

    const copyLink = async () => {
        try {
            await navigator.clipboard.writeText(link.value)
            notify('Link copied')
        } catch {
            link.select()
            notify('Press ⌘C to copy')
        }
    }

    form?.addEventListener('change', async (event) => {
        const visibility = event.target.value
        const inputs = [...form.querySelectorAll('input')]
        inputs.forEach((input) => (input.disabled = true))
        try {
            const response = await fetch(`/a/${form.dataset.artifact}/visibility`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visibility }),
            })
            if (!response.ok) throw new Error(await response.text())
            const isPublic = visibility === 'public'
            link.disabled = !isPublic
            copy.disabled = !isPublic
            if (pill) {
                pill.className = isPublic ? 'pill public' : 'pill'
                pill.lastChild.textContent = isPublic ? ' Public' : ' Private'
            }
            if (isPublic) await copyLink()
            else notify('Only you can view this now')
        } catch {
            form.querySelector(`input[value="${visibility === 'public' ? 'private' : 'public'}"]`).checked = true
            notify("Couldn't update sharing. Try again.")
        } finally {
            inputs.forEach((input) => (input.disabled = false))
        }
    })
    copy?.addEventListener('click', copyLink)
})()
