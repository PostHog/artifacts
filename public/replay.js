// Session replay for our pages, including the artifact inside the viewer's iframe. See src/lib/replay.ts.
// Loaded on every page; does nothing unless /replay/config says replay is on.
;(async () => {
    let config
    try {
        const response = await fetch('/replay/config', { credentials: 'same-origin', cache: 'no-store' })
        if (!response.ok) return
        config = await response.json()
    } catch {
        return
    }
    if (!config?.enabled) return

    // The page's full snapshot interval. The artifact frame is asked for a fresh snapshot on the same beat, so a
    // replay that starts at a later checkout still has the artifact in it.
    const SNAPSHOT_MS = 5 * 60 * 1000
    const artifactId = location.pathname.match(/^\/a\/([A-Za-z0-9_-]+)/)?.[1]
    // Content is on an opaque origin, so match frames by window rather than origin.
    const frameFor = (source) => [...document.querySelectorAll('iframe')].find((frame) => frame.contentWindow === source)

    // rrweb only accepts a cross-origin iframe's events when the message's origin equals the origin the frame
    // reports (location.origin). A sandboxed frame reports its URL's origin but its messages arrive as "null", so
    // rrweb would drop them all. Re-dispatch them with the reported origin, only for our own artifact frames
    // reporting our content origin. This runs in the capture phase, before rrweb's listener.
    window.addEventListener(
        'message',
        (event) => {
            const data = event.data
            if (data?.type !== 'rrweb' || event.origin !== 'null' || data.origin !== config.content_origin || !frameFor(event.source)) return
            event.stopImmediatePropagation()
            window.dispatchEvent(new MessageEvent('message', { data, origin: data.origin, source: event.source }))
        },
        true
    )

    const script = document.createElement('script')
    script.src = `${config.assets_host}/static/array.js`
    script.async = true
    script.onload = () => {
        const posthog = window.posthog
        if (!posthog?.init) return
        posthog.init(config.token, {
            api_host: config.api_host,
            // One cookie per identity: bootstrap only applies to an empty store, so this keeps a later guest or
            // anonymous session in the same browser from inheriting a staff member's distinct ID.
            persistence_name: config.persistence_name,
            bootstrap: config.distinct_id ? { distinctID: config.distinct_id } : undefined,
            // Like the server-side events: staff already have profiles in this project, so don't create more.
            person_profiles: 'never',
            autocapture: false,
            capture_pageview: true,
            capture_pageleave: true,
            disable_surveys: true,
            // Started explicitly below, so every session is recorded whatever the project's sampling and triggers.
            disable_session_recording: true,
            session_recording: { recordCrossOriginIframes: true, full_snapshot_interval_millis: SNAPSHOT_MS },
            loaded: (ph) => {
                ph.register({ app: 'posthog-artifacts', viewer: config.viewer, ...(artifactId && { artifact_id: artifactId }) })
                ph.startSessionRecording(true)
                recordFrames(ph)
            },
        })
    }
    document.head.append(script)

    // Tells artifact frames to start (or re-snapshot) their recorder; see src/web/replay-frame.ts.
    function recordFrames(ph) {
        let started = false
        const ask = (frame) => frame?.contentWindow?.postMessage({ phr: 1, type: 'record', version: ph.version }, '*')
        const askAll = () => started && document.querySelectorAll('iframe').forEach(ask)

        window.addEventListener('message', (event) => {
            if (event.data?.phr === 1 && event.data.type === 'ready' && started) ask(frameFor(event.source))
        })
        document.querySelectorAll('iframe').forEach((frame) => frame.addEventListener('load', () => started && setTimeout(() => ask(frame), 300)))
        ph.onSessionId?.(() => setTimeout(askAll, 500))
        setInterval(askAll, SNAPSHOT_MS)

        // Wait for the page's recorder to be running (it loads lazily), so it has registered the iframe before the
        // frame's first full snapshot arrives.
        const wait = setInterval(() => {
            if (!ph.sessionRecordingStarted()) return
            clearInterval(wait)
            started = true
            setTimeout(askAll, 300)
        }, 250)
        setTimeout(() => clearInterval(wait), 60_000)
    }
})()
