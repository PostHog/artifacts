/**
 * The "slides" format: the author writes one HTML document in which every <section> directly inside
 * <body> is a slide, designed for a 1280×720 canvas. At serve time we add a deck viewer around it:
 * a thumbnail rail on the left, the current slide scaled to fit, keyboard navigation and a
 * present mode. Everything runs inside the artifact's sandboxed iframe, like any other content.
 *
 * Slides stay where the author put them, as children of <body>, so author CSS like `body > section`
 * keeps matching. They are position: fixed over an empty stage box whose centre JS tracks.
 * Inactive slides stay laid out at full size (visibility: hidden, never display: none) so charts
 * that measure their container render correctly on slides you haven't visited yet.
 */

const W = 1280
const H = 720

// Layout rules are class-scoped so they beat an author's `section { … }`. Cosmetic defaults sit in
// :where() (zero specificity) so any author rule overrides them.
const DECK_CSS = `
/* Slides are body > section; their thumbnails are clones inside the rail. */
body > section, .ph-frame > section { box-sizing: border-box; width: ${W}px; height: ${H}px; overflow: hidden; }
:where(body > section, .ph-frame > section) { padding: 64px 80px; background: #fff; color: #23251d; }
html:has(body.ph-deck), body.ph-deck { height: 100%; margin: 0; }
body.ph-deck { display: flex; overflow: hidden; background: #e5e7e0; --ph-thumb: 168; }
/* Only the deck shows: anything else the author put in <body> is hidden. */
body.ph-deck > :not(section, .ph-deck-stage, .ph-deck-rail) { display: none; }
.ph-deck-stage { flex: 1; position: relative; overflow: hidden; min-width: 0; }
body.ph-deck > section.ph-slide { position: fixed; left: var(--ph-cx, 50%); top: var(--ph-cy, 50%); margin: 0; visibility: hidden;
  transform: translate(-50%, -50%) scale(var(--ph-scale, 1)); box-shadow: 0 1px 3px rgba(0,0,0,.12), 0 8px 24px rgba(0,0,0,.08); }
body.ph-deck > section.ph-slide.ph-active { visibility: visible; }
.ph-deck-rail { order: -1; flex: 0 0 auto; width: calc(var(--ph-thumb) * 1px + 52px); overflow-y: auto; box-sizing: border-box;
  padding: 14px 12px; display: flex; flex-direction: column; gap: 12px; background: #eeefe9; border-right: 1px solid #d2d3cc; }
.ph-deck-thumb { all: unset; display: flex; gap: 8px; cursor: pointer; font: 600 11px/1 system-ui, sans-serif; color: #73756b; }
.ph-deck-thumb .ph-n { width: 16px; text-align: right; padding-top: 3px; flex: none; }
.ph-deck-thumb .ph-frame { position: relative; flex: none; width: calc(var(--ph-thumb) * 1px); height: calc(var(--ph-thumb) * ${H / W}px);
  overflow: hidden; border-radius: 4px; background: #fff; box-shadow: 0 0 0 1px #d2d3cc; }
.ph-deck-thumb .ph-frame > section { position: absolute; left: 0; top: 0; margin: 0; transform-origin: 0 0;
  transform: scale(calc(var(--ph-thumb) / ${W})); pointer-events: none; }
.ph-deck-thumb:hover .ph-frame { box-shadow: 0 0 0 1px #9ea096; }
.ph-deck-thumb[aria-current="true"] { color: #23251d; }
.ph-deck-thumb[aria-current="true"] .ph-frame { box-shadow: 0 0 0 2px #eb9d2a; }
.ph-deck-thumb:focus-visible .ph-frame { outline: 2px solid #2f80fa; outline-offset: 2px; }
.ph-deck-bar { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); display: flex; align-items: center; gap: 4px;
  padding: 4px; border-radius: 8px; background: rgba(253,253,248,.92); box-shadow: 0 0 0 1px #d2d3cc; font: 500 12px/1 system-ui, sans-serif; color: #4d4f46; }
.ph-deck-bar button { all: unset; cursor: pointer; padding: 6px 9px; border-radius: 5px; }
.ph-deck-bar button:hover { background: #e5e7e0; color: #23251d; }
.ph-deck-bar button:focus-visible { outline: 2px solid #2f80fa; }
.ph-deck-bar .ph-count { min-width: 52px; text-align: center; font-variant-numeric: tabular-nums; }
body.ph-deck.ph-presenting { background: #000; }
body.ph-presenting .ph-deck-rail, body.ph-presenting .ph-deck-bar { display: none; }
body.ph-presenting > section.ph-slide { box-shadow: none; }
@media (max-width: 720px) {
  body.ph-deck { flex-direction: column; --ph-thumb: 96; }
  .ph-deck-rail { order: 1; width: auto; flex-direction: row; overflow: auto hidden; border-right: 0; border-top: 1px solid #d2d3cc; padding: 10px; }
}
@media (prefers-color-scheme: dark) {
  body.ph-deck { background: #1d1f17; }
  .ph-deck-rail { background: #23251d; border-color: #3b3d34; }
  .ph-deck-thumb { color: #9ea096; } .ph-deck-thumb[aria-current="true"] { color: #eeefe9; }
  .ph-deck-thumb .ph-frame { box-shadow: 0 0 0 1px #3b3d34; }
  .ph-deck-bar { background: rgba(35,37,29,.92); box-shadow: 0 0 0 1px #3b3d34; color: #c8cac1; }
  .ph-deck-bar button:hover { background: #2a2c24; color: #eeefe9; }
}
`

const DECK_JS = `(() => {
  const W = ${W}, H = ${H}
  const SKIP = /^(position|inset|left|top|right|bottom|margin|transform|translate|scale|rotate|visibility|box-shadow|pointer-events|width|height)/
  const init = () => {
    const slides = [...document.body.children].filter((el) => el.tagName === 'SECTION')
    if (!slides.length) return
    const el = (tag, cls, attrs = {}) => Object.assign(document.createElement(tag), { className: cls }, attrs)
    const stage = el('main', 'ph-deck-stage')
    const rail = el('nav', 'ph-deck-rail', { ariaLabel: 'Slides' })
    const bar = el('div', 'ph-deck-bar')
    const prev = el('button', '', { type: 'button', textContent: '\\u2190', title: 'Previous (\\u2190)' })
    const count = el('span', 'ph-count')
    const next = el('button', '', { type: 'button', textContent: '\\u2192', title: 'Next (\\u2192)' })
    const present = el('button', '', { type: 'button', textContent: 'Present', title: 'Present (F)' })
    bar.append(prev, count, next, present)
    // The rail comes after the slides in the DOM (CSS puts it on the left), so the author's own
    // getElementById() and SVG url(#…) references keep resolving to the real slides, not thumbnails.
    stage.append(bar)
    document.body.prepend(stage)
    document.body.append(rail)
    document.body.classList.add('ph-deck')

    const thumbs = slides.map((slide, i) => {
      slide.classList.add('ph-slide')
      slide.setAttribute('role', 'group')
      slide.setAttribute('aria-roledescription', 'slide')
      slide.setAttribute('aria-label', (i + 1) + ' of ' + slides.length)
      const button = el('button', 'ph-deck-thumb', { type: 'button', title: 'Slide ' + (i + 1) })
      const frame = el('span', 'ph-frame')
      button.append(el('span', 'ph-n', { textContent: i + 1 }), frame)
      button.addEventListener('click', () => go(i))
      rail.append(button)
      return frame
    })

    // Thumbnails are inert clones. Scripts in a clone never run, so copy canvas pixels across
    // (charts), and drop embedded media rather than load it twice.
    const snapshot = (i) => {
      const slide = slides[i]
      const clone = slide.cloneNode(true)
      clone.classList.remove('ph-slide', 'ph-active')
      clone.removeAttribute('role')
      clone.inert = true
      clone.setAttribute('aria-hidden', 'true')
      // Author rules like \`body > section { … }\` can't match a clone in the rail, so carry the
      // slide's own computed style across, minus the properties that place it in the deck.
      const computed = getComputedStyle(slide)
      for (const name of computed) {
        if (!SKIP.test(name)) clone.style.setProperty(name, computed.getPropertyValue(name))
      }
      clone.querySelectorAll('iframe, video, audio, object, embed').forEach((m) => m.replaceWith(el('div', '')))
      const from = slide.querySelectorAll('canvas')
      clone.querySelectorAll('canvas').forEach((c, j) => {
        try { c.width = from[j].width; c.height = from[j].height; c.getContext('2d').drawImage(from[j], 0, 0) } catch {}
      })
      thumbs[i].replaceChildren(clone)
    }
    const snapshotAll = () => slides.forEach((_, i) => snapshot(i))

    let current = -1
    let presenting = false
    const fit = () => {
      const pad = presenting ? 0 : 48
      const barSpace = presenting ? 0 : 44
      const box = stage.getBoundingClientRect()
      const scale = Math.min((box.width - pad) / W, (box.height - pad - barSpace) / H)
      const style = document.body.style
      style.setProperty('--ph-scale', Math.max(scale, 0.05))
      style.setProperty('--ph-cx', box.left + box.width / 2 + 'px')
      style.setProperty('--ph-cy', box.top + (box.height - barSpace) / 2 + 'px')
    }
    const go = (i) => {
      i = Math.max(0, Math.min(slides.length - 1, i))
      if (i === current) return
      if (current >= 0) {
        slides[current].classList.remove('ph-active')
        rail.children[current].removeAttribute('aria-current')
        snapshot(current) // pick up anything that changed while it was on screen
      }
      current = i
      slides[i].classList.add('ph-active')
      rail.children[i].setAttribute('aria-current', 'true')
      rail.children[i].scrollIntoView({ block: 'nearest', inline: 'nearest' })
      count.textContent = (i + 1) + ' / ' + slides.length
      prev.disabled = i === 0
      next.disabled = i === slides.length - 1
      try { history.replaceState(null, '', '#' + (i + 1)) } catch {}
    }
    const setPresenting = (on) => {
      presenting = on
      document.body.classList.toggle('ph-presenting', on)
      fit()
    }

    prev.addEventListener('click', () => go(current - 1))
    next.addEventListener('click', () => go(current + 1))
    present.addEventListener('click', () => {
      setPresenting(true)
      document.documentElement.requestFullscreen?.().catch(() => {})
    })
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) setPresenting(false) })
    document.addEventListener('keydown', (event) => {
      const t = event.target
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (t.closest && t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return
      const key = event.key
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(key)) go(current + 1)
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(key)) go(current - 1)
      else if (key === 'Home') go(0)
      else if (key === 'End') go(slides.length - 1)
      else if (key === 'f' || key === 'F') present.click()
      else if (key === 'Escape' && presenting) setPresenting(false)
      else return
      event.preventDefault()
    })

    new ResizeObserver(fit).observe(stage)
    fit()
    snapshotAll()
    go((parseInt(location.hash.slice(1), 10) || 1) - 1)
    // Charts usually draw (and animate) after load; refresh the thumbnails once they have.
    const later = () => setTimeout(snapshotAll, 1200)
    if (document.readyState === 'complete') later()
    else addEventListener('load', later)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init)
  else init()
})()`

// Closing-tag sequences can't appear in the inline blocks above; this keeps it that way if they change.
if (/<\/(style|script)/i.test(DECK_CSS + DECK_JS)) throw new Error('deck assets must not contain closing tags')

const DECK_HEAD = `<style data-ph-deck>${DECK_CSS}</style>\n<script data-ph-deck>${DECK_JS}</script>`

/** Wraps a slides document in the deck viewer, inserting it at the top of <head> (after the doctype). */
export function renderSlides(html: string): string {
    // Without a doctype the page renders in quirks mode, which breaks the 100%-height layout.
    const doc = /^\s*<!doctype/i.test(html) ? html : `<!doctype html>${html}`
    const anchor = /<head(?=[\s>])[^>]*>/i.exec(doc) ?? /^\s*<!doctype[^>]*>/i.exec(doc)!
    const at = anchor.index + anchor[0].length
    return doc.slice(0, at) + DECK_HEAD + doc.slice(at)
}
