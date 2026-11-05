/**
 * Lets viewers comment on a passage. A small script is added to the artifact's own response, so it runs
 * inside the same sandboxed iframe as the artifact (opaque origin, no cookies, no access to the viewer page).
 * It does three things and talks to the viewer only through postMessage:
 *
 *  - when text is selected, shows a "Comment" button and, on click, sends the viewer the selection as an anchor
 *    (the exact text plus up to 32 characters either side)
 *  - given the anchors of existing comments, highlights them with the CSS Custom Highlight API, which doesn't
 *    touch the artifact's DOM (browsers without it get no highlights, but comments and quotes still work)
 *  - on request, scrolls a comment's passage into view; on click of a highlight, tells the viewer which comment
 *
 * Anchors are text quotes (W3C Web Annotation "TextQuoteSelector"): there's no DOM path to break when the author
 * publishes a new version, and a comment whose text is gone just shows as "can't find this text".
 * Everything the script receives or sends is treated as untrusted on both sides: the artifact's own code shares
 * this realm and can send the same messages, which is why the viewer only ever puts them in a form the person
 * still has to submit.
 */
const SCRIPT = String.raw`(function () {
  if (window.__paInstalled) return;
  window.__paInstalled = true;
  var PARENT = __PARENT_ORIGIN__;
  var CONTEXT = 32, MAX = 500;
  var canComment = false, items = [], ranges = {}, host = null, btn = null, timer = 0;

  function post(msg) { msg.pa = 1; try { window.parent.postMessage(msg, PARENT); } catch (e) {} }

  // The text we anchor against: every text node in the body except scripts, styles, our own button and the slide deck's chrome.
  function skipped(node) {
    for (var p = node.parentNode; p && p !== document.documentElement; p = p.parentNode) {
      var n = p.nodeName;
      if (n === 'SCRIPT' || n === 'STYLE' || n === 'NOSCRIPT' || n === 'TEMPLATE' || n === 'TEXTAREA') return true;
      if (p.id === '__pa_host') return true;
      if (p.classList && (p.classList.contains('ph-deck-rail') || p.classList.contains('ph-deck-bar'))) return true;
    }
    return false;
  }
  function index() {
    var entries = [], text = '';
    if (!document.body) return { entries: entries, text: text };
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), node;
    while ((node = walker.nextNode())) {
      if (skipped(node)) continue;
      entries.push({ node: node, start: text.length });
      text += node.nodeValue;
    }
    return { entries: entries, text: text };
  }

  // A DOM boundary point as an offset into index().text.
  function offsetOf(ix, container, offset) {
    var i;
    if (container.nodeType === 3) {
      for (i = 0; i < ix.entries.length; i++) if (ix.entries[i].node === container) return ix.entries[i].start + offset;
      return null;
    }
    var boundary = document.createRange();
    boundary.setStart(container, offset);
    boundary.collapse(true);
    for (i = 0; i < ix.entries.length; i++) {
      var at = document.createRange();
      at.setStart(ix.entries[i].node, 0);
      at.collapse(true);
      if (boundary.compareBoundaryPoints(Range.START_TO_START, at) <= 0) return ix.entries[i].start;
    }
    return ix.text.length;
  }

  function currentAnchor() {
    var sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    var range = sel.getRangeAt(0), ix = index();
    var s = offsetOf(ix, range.startContainer, range.startOffset);
    var e = offsetOf(ix, range.endContainer, range.endOffset);
    if (s == null || e == null || e <= s) return null;
    var t = ix.text;
    while (s < e && /\s/.test(t.charAt(s))) s++;
    while (e > s && /\s/.test(t.charAt(e - 1))) e--;
    if (e - s > MAX) e = s + MAX;
    if (e <= s) return null;
    return { exact: t.slice(s, e), prefix: t.slice(Math.max(0, s - CONTEXT), s), suffix: t.slice(e, e + CONTEXT), rect: range.getBoundingClientRect() };
  }

  function rangeFor(ix, s, e) {
    var range = document.createRange(), started = false;
    for (var i = 0; i < ix.entries.length; i++) {
      var en = ix.entries[i], end = en.start + en.node.nodeValue.length;
      if (!started && s < end) { range.setStart(en.node, Math.max(0, s - en.start)); started = true; }
      if (started && e <= end) { range.setEnd(en.node, e - en.start); return range; }
    }
    return null;
  }

  // Finds the best occurrence of the quote: the one whose surrounding text matches the stored context the most.
  function locate(a) {
    var ix = index(), t = ix.text, best = -1, bestScore = -1, from = 0, tries = 0, at, i, score;
    while (tries++ < 200 && (at = t.indexOf(a.exact, from)) !== -1) {
      score = 0;
      for (i = 1; i <= a.prefix.length && t.charAt(at - i) === a.prefix.charAt(a.prefix.length - i); i++) score++;
      for (i = 0; i < a.suffix.length && t.charAt(at + a.exact.length + i) === a.suffix.charAt(i); i++) score++;
      if (score > bestScore) { bestScore = score; best = at; }
      from = at + 1;
    }
    return best < 0 ? null : rangeFor(ix, best, best + a.exact.length);
  }

  var style = document.createElement('style');
  style.textContent = '::highlight(pa-comments){background-color:rgba(245,166,35,.35)}::highlight(pa-active){background-color:rgba(245,78,0,.4)}';
  document.documentElement.appendChild(style);

  function paint(activeId) {
    ranges = {};
    var all = [], found = [], active = [];
    for (var i = 0; i < items.length; i++) {
      var r = locate(items[i]);
      if (!r) continue;
      ranges[items[i].id] = r;
      all.push(r);
      found.push(items[i].id);
      if (items[i].id === activeId) active.push(r);
    }
    if (window.CSS && CSS.highlights && window.Highlight) {
      CSS.highlights.set('pa-comments', new Highlight(...all));
      CSS.highlights.set('pa-active', new Highlight(...active));
    }
    post({ type: 'resolved', ids: found });
  }

  // For slide decks: switch to the slide the passage is on before scrolling to it.
  function reveal(range) {
    var el = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : range.startContainer;
    if (!el) return;
    var slide = el.closest && el.closest('body > section');
    if (slide && slide.classList.contains('ph-slide') && !slide.classList.contains('ph-active')) {
      var slides = Array.prototype.slice.call(document.querySelectorAll('body > section')), thumbs = document.querySelectorAll('.ph-deck-thumb');
      var n = slides.indexOf(slide);
      if (thumbs[n]) thumbs[n].click();
    }
    setTimeout(function () { if (el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60);
  }

  function hide() { if (host) host.style.display = 'none'; }
  function ensureButton() {
    if (host) return;
    host = document.createElement('div');
    host.id = '__pa_host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;display:none';
    var root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>button{font:600 12px/1 system-ui,sans-serif;padding:7px 10px;border-radius:6px;border:0;background:#1d1f17;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.3);cursor:pointer}button:hover{background:#f54e00}</style><button type="button">Comment</button>';
    btn = root.querySelector('button');
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () {
      var a = currentAnchor();
      if (a) post({ type: 'compose', anchor: { exact: a.exact, prefix: a.prefix, suffix: a.suffix } });
      hide();
    });
    document.documentElement.appendChild(host);
  }
  function maybeShow() {
    if (!canComment) return hide();
    var a = currentAnchor();
    if (!a) return hide();
    ensureButton();
    host.style.left = Math.max(8, Math.min(a.rect.right - 40, window.innerWidth - 96)) + 'px';
    host.style.top = Math.max(8, Math.min(a.rect.bottom + 8, window.innerHeight - 40)) + 'px';
    host.style.display = 'block';
  }
  document.addEventListener('selectionchange', function () { clearTimeout(timer); timer = setTimeout(maybeShow, 220); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);

  // Clicking a highlighted passage tells the viewer which comment it belongs to.
  document.addEventListener('click', function (ev) {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    var node = null, off = 0, p, r;
    if (document.caretPositionFromPoint) { p = document.caretPositionFromPoint(ev.clientX, ev.clientY); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { r = document.caretRangeFromPoint(ev.clientX, ev.clientY); if (r) { node = r.startContainer; off = r.startOffset; } }
    if (!node) return;
    for (var id in ranges) {
      try { if (ranges[id].isPointInRange(node, off)) { post({ type: 'focus', id: id }); return; } } catch (e) {}
    }
  }, true);

  function str(v, n) { return typeof v === 'string' ? v.slice(0, n) : ''; }
  window.addEventListener('message', function (e) {
    if (e.source !== window.parent) return;
    var m = e.data;
    if (!m || m.pa !== 1) return;
    if (m.type === 'config') {
      canComment = !!m.canComment;
      if (!canComment) hide();
    } else if (m.type === 'highlights' && Array.isArray(m.items)) {
      items = [];
      for (var i = 0; i < Math.min(m.items.length, 500); i++) {
        var it = m.items[i];
        if (it && typeof it.id === 'string' && typeof it.exact === 'string' && it.exact) {
          items.push({ id: it.id.slice(0, 40), exact: str(it.exact, MAX), prefix: str(it.prefix, CONTEXT), suffix: str(it.suffix, CONTEXT) });
        }
      }
      paint();
    } else if (m.type === 'scroll' && typeof m.id === 'string') {
      paint(m.id);
      if (ranges[m.id]) reveal(ranges[m.id]);
    }
  });
  post({ type: 'ready' });
})();`

/** Adds the annotator just before </body> (or at the end, if the artifact has no closing tag). */
export function injectAnnotator(html: string, parentOrigin: string): string {
    const tag = `<script>${SCRIPT.replace('__PARENT_ORIGIN__', JSON.stringify(parentOrigin))}</script>`
    let at = -1
    for (const match of html.matchAll(/<\/body\s*>/gi)) at = match.index
    return at === -1 ? html + tag : html.slice(0, at) + tag + html.slice(at)
}
