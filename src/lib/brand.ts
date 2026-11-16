/**
 * PostHog brand layer for HTML and slides artifacts, from the brandbook (https://brand.posthog.com/llms.txt).
 *
 * The layer links the brand's own stylesheets (RoundHog @font-face rules and the `--posthog-*` colour variables,
 * both served with CORS enabled) instead of copying them, so artifacts follow the brandbook when it changes. The
 * small style block after them only sets the typeface on text elements. It uses plain element selectors, so any
 * class or id rule the author wrote still wins. Finishing the job (logo, palette, copy) is up to the agent, which
 * is what BRAND_GUIDELINES is for.
 */

const BRAND_ORIGIN = 'https://brand.posthog.com'

/** Present in a branded document, so applying the layer twice is a no-op. */
const MARKER = 'data-posthog-brand'

const LAYER = `<link rel="stylesheet" href="${BRAND_ORIGIN}/fonts/roundhog.css" ${MARKER}>
<link rel="stylesheet" href="${BRAND_ORIGIN}/colors.css" ${MARKER}>
<style ${MARKER}>
body, button, input, select, textarea, h1, h2, h3, h4, h5, h6, p, li, td, th, figcaption, label { font-family: "RoundHog", sans-serif; }
</style>
`

export function isBranded(html: string): boolean {
    return html.includes(MARKER)
}

/** Adds the brand layer to an HTML document, at the end of <head> so it follows the author's own base styles. */
export function applyBrand(html: string): string {
    if (isBranded(html)) return html
    const closeHead = /<\/head\s*>/i.exec(html)
    if (closeHead) return html.slice(0, closeHead.index) + LAYER + html.slice(closeHead.index)
    // Find the tag name, then its closing '>' once. A regex that spans the attributes ([^>]*) retries from every
    // later '<head ' when the '>' is missing, which is quadratic on untrusted content. If this tag has no '>',
    // no later one does either.
    const openHead = /<head(?=[\s>])/i.exec(html)
    const openHeadEnd = openHead ? html.indexOf('>', openHead.index) : -1
    if (openHeadEnd !== -1) return html.slice(0, openHeadEnd + 1) + '\n' + LAYER + html.slice(openHeadEnd + 1)
    // No <head>: keep the layer after the doctype (anything before it triggers quirks mode) and any <html> tag.
    const prologue = /^\s*(<!doctype[^>]*>\s*)?(<html(\s[^>]*)?>\s*)?/i.exec(html)![0]
    return prologue + LAYER + html.slice(prologue.length)
}

export const BRAND_GUIDELINES = `The PostHog brand layer was added to the new version: the RoundHog typeface and the --posthog-* colour variables. It does not restyle what the author set explicitly, so finish the job by editing the content and publishing it as a new version (artifact_id, with a note). Source of truth: ${BRAND_ORIGIN}/llms.txt.
- Typeface: font-family "RoundHog", sans-serif (weights 400, 500, 700 and 800; 700 is SemiBold, 800 is Bold). Use a monospace face for code. Don't keep another brand typeface.
- Colours: use the brand palette instead of invented colours, as var(--posthog-blue) and so on, each with -lighter and -darker variants. Palette: blue #1490E8, cobalt #0457FF, coral #FF474D, corn blue #2BB3DF, green #47C861, lemon #FFCE1C, lime #A0CA21, purple #A737D2, tangerine #FF5C1C, teal #43DAB3, violet #6D4FFF, yellow #FFA81C. Full list: ${BRAND_ORIGIN}/colors.md. For charts, use these in a consistent order.
- Logo: ${BRAND_ORIGIN}/logo/posthog-logo.svg (full colour) on light backgrounds. On dark backgrounds use posthog-logo-white.svg, never the standard logo. Use the stacked logo (posthog-logo-stacked.svg) for tall or square spaces and the logomark alone only at small sizes. Don't recolour the logomark, stretch it, or set "PostHog" in plain text beside it. All logos: ${BRAND_ORIGIN}/logo.md.
- Illustrations: hedgehogs ("hoggies") are at ${BRAND_ORIGIN}/hoggies/{slug}.svg, and the catalogue is ${BRAND_ORIGIN}/catalog.json. Use one where it adds something, such as a title slide or an empty state, not as decoration on every page.
- Link logos and illustrations by URL (SVG preferred) rather than embedding them as base64, which counts against the size limit.`
