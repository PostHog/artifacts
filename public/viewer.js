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

    // --- Comments on a passage -------------------------------------------------------------------
    // The artifact runs in a sandboxed iframe we can't read, so a small script served with it (src/web/annotate.ts)
    // reports selections and highlights comments, over postMessage. Everything it sends is untrusted text: it only
    // ever fills a form the person still has to submit, or toggles a class.
    const frame = document.querySelector('.viewer iframe')
    const panel = document.querySelector('[data-comments]')
    if (frame && panel) {
        const canComment = panel.dataset.canComment === '1'
        const commentForm = panel.querySelector('[data-comment-form]')
        const send = (message) => frame.contentWindow?.postMessage({ pa: 1, ...message }, '*')
        const items = () =>
            [...panel.querySelectorAll('[data-comment-id][data-exact]')].map((li) => ({
                id: li.dataset.commentId,
                exact: li.dataset.exact,
                prefix: li.dataset.prefix || '',
                suffix: li.dataset.suffix || '',
            }))
        const sync = () => {
            send({ type: 'config', canComment })
            send({ type: 'highlights', items: items() })
        }
        frame.addEventListener('load', sync)
        sync()

        const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : '')
        const composing = commentForm?.querySelector('[data-composing]')
        const setAnchor = (anchor) => {
            for (const [name, max] of [['anchor_exact', 500], ['anchor_prefix', 64], ['anchor_suffix', 64]]) {
                commentForm.elements[name].value = anchor ? text(anchor[name.slice(7)], max) : ''
            }
            const exact = commentForm.elements.anchor_exact.value
            composing.hidden = !exact
            composing.querySelector('[data-composing-text]').textContent = exact.length > 80 ? exact.slice(0, 80) + '…' : exact
        }
        commentForm?.querySelector('[data-composing-clear]')?.addEventListener('click', () => setAnchor(null))

        const flash = (id) => {
            const li = panel.querySelector(`[data-comment-id="${CSS.escape(id)}"]`)
            if (!li) return
            panel.open = true
            li.scrollIntoView({ block: 'nearest' })
            li.classList.add('flash')
            setTimeout(() => li.classList.remove('flash'), 1600)
        }

        window.addEventListener('message', (event) => {
            if (event.source !== frame.contentWindow) return
            const message = event.data
            if (!message || message.pa !== 1) return
            if (message.type === 'ready') sync()
            else if (message.type === 'resolved' && Array.isArray(message.ids)) {
                const found = new Set(message.ids.map(String))
                for (const li of panel.querySelectorAll('[data-exact]')) li.classList.toggle('lost', !found.has(li.dataset.commentId))
            } else if (message.type === 'compose' && canComment && commentForm && message.anchor && typeof message.anchor.exact === 'string') {
                setAnchor(message.anchor)
                panel.open = true
                commentForm.elements.body.focus()
            } else if (message.type === 'focus' && typeof message.id === 'string') flash(message.id)
        })

        panel.addEventListener('click', (event) => {
            const quote = event.target.closest?.('[data-quote]')
            if (quote) send({ type: 'scroll', id: quote.dataset.quote })
        })
    }

    // Agent handover: fetch fresh links each time the popover opens, so a page left open for hours still works.
    // The links are plain <a href>s, so the click itself opens the app (browsers require a click for that).
    const handover = document.querySelector('[data-handover]')
    if (handover) {
        const links = [...handover.querySelectorAll('[data-handover-link]')]
        const copyPrompt = handover.querySelector('[data-handover-copy]')
        const error = handover.querySelector('[data-handover-error]')
        let prompt = ''
        const setReady = (ready) => {
            for (const a of links) a.setAttribute('aria-disabled', ready ? 'false' : 'true')
            copyPrompt.disabled = !ready
        }
        handover.addEventListener('toggle', async () => {
            if (!handover.open) return
            setReady(false)
            error.hidden = true
            try {
                const response = await fetch(`/a/${handover.dataset.handover}/handover`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ v: Number(handover.dataset.version) }),
                })
                if (!response.ok) throw new Error(String(response.status))
                const data = await response.json()
                for (const a of links) a.href = data[a.dataset.handoverLink]
                prompt = data.prompt
                setReady(true)
            } catch {
                error.hidden = false
            }
        })
        for (const a of links) a.addEventListener('click', () => setTimeout(() => (handover.open = false), 0))
        copyPrompt.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(prompt)
                notify('Prompt copied')
            } catch {
                notify("Couldn't copy the prompt")
            }
            handover.open = false
        })
    }

    document.querySelector('[data-fullscreen]')?.addEventListener('click', () => {
        document.querySelector('.viewer iframe')?.requestFullscreen?.().catch(() => {})
    })
})()
