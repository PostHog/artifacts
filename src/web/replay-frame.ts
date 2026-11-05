/**
 * Session replay inside the artifact iframe (see src/lib/replay.ts). The content runs with an opaque origin, so the
 * page's recorder can't serialise it. This script, added to the artifact's response like the annotator, runs
 * PostHog's own rrweb build (lazy-recorder.js, the same versioned file posthog-js loads on the page) with recordCrossOriginIframes,
 * which makes rrweb hand every event to window.parent with postMessage instead of emitting it here. The page's
 * recorder stitches them into its replay. Nothing in the frame talks to PostHog or stores anything.
 *
 * It does nothing until the page asks: the page sends { phr: 1, type: 'record' } once its own recording has started
 * (so the frame's first full snapshot lands after the page has registered the iframe), on every iframe load, on a
 * new replay session, and each time the page takes a periodic full snapshot. The first request starts rrweb; later
 * ones take a fresh full snapshot so the new session or checkout has the artifact's DOM too.
 */
const SCRIPT = String.raw`(function () {
  if (window.__phrInstalled || window.parent === window) return;
  window.__phrInstalled = true;
  var ASSETS = __ASSETS_HOST__, PARENT = __PARENT_ORIGIN__;
  var record = null, loading = false;

  function start(version) {
    if (record) { try { record.takeFullSnapshot(true); } catch (e) {} return; }
    if (loading) return;
    loading = true;
    var s = document.createElement('script');
    s.src = ASSETS + '/static/' + (version ? version + '/' : '') + 'lazy-recorder.js';
    s.async = true;
    s.onload = function () {
      var rr = window.__PosthogExtensions__ && window.__PosthogExtensions__.rrweb;
      if (!rr || typeof rr.record !== 'function') return;
      // Match posthog-js's defaults on the page: inputs masked, text not, same opt-out classes.
      rr.record({
        emit: function () {},
        recordCrossOriginIframes: true,
        maskAllInputs: true,
        maskInputOptions: { password: true },
        blockClass: 'ph-no-capture',
        maskTextClass: 'ph-mask',
        inlineStylesheet: true,
        collectFonts: false,
        recordCanvas: false
      });
      record = rr.record;
    };
    s.onerror = function () { loading = false; };
    (document.head || document.documentElement).appendChild(s);
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.phr !== 1 || m.type !== 'record') return;
    // Load the recorder build that matches the page's posthog-js, so both speak the same rrweb.
    start(typeof m.version === 'string' && /^\d+\.\d+\.\d+$/.test(m.version) ? m.version : '');
  });
  // In case the page is already recording by the time this frame loads.
  try { window.parent.postMessage({ phr: 1, type: 'ready' }, PARENT); } catch (e) {}
})();`

export function injectReplayRecorder(html: string, assetsHost: string, parentOrigin: string): string {
    const tag = `<script>${SCRIPT.replace('__ASSETS_HOST__', JSON.stringify(assetsHost)).replace('__PARENT_ORIGIN__', JSON.stringify(parentOrigin))}</script>`
    let at = -1
    for (const match of html.matchAll(/<\/body\s*>/gi)) at = match.index
    return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at)
}
