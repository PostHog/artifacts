import type { ConsentDescription } from '@cloudflare/workers-oauth-provider'
import { html, raw } from 'hono/html'
import type { HtmlEscapedString } from 'hono/utils/html'
import type { User } from '../env'
import type { PublicQuiz, QuestionStats, QuizQuestion } from '../lib/quiz'
import type { QuizAttempt } from '../quiz-store'
import type { Artifact, Comment, Commenter, Version } from '../store'
import { SANDBOX } from './content'

type Html = HtmlEscapedString | Promise<HtmlEscapedString>

interface LayoutOptions {
    title: string
    description?: string
    body: Html
    bodyClass?: string
    /** Open Graph tags are only emitted for content that is safe to unfurl (public artifacts, landing page). */
    og?: { title: string; description?: string; url: string }
}

export function layout({ title, description, body, bodyClass, og }: LayoutOptions) {
    return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="same-origin">
<title>${title}</title>
${description ? html`<meta name="description" content="${description}">` : ''}
${og
    ? html`<meta property="og:site_name" content="PostHog Artifacts">
<meta property="og:title" content="${og.title}">
${og.description ? html`<meta property="og:description" content="${og.description}">` : ''}
<meta property="og:url" content="${og.url}">
<meta property="og:type" content="article">`
    : ''}
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/styles.css">
</head>
<body class="${bodyClass ?? ''}">
${body}
</body>
</html>`
}

const logo = html`<img class="logo-light" src="/logo.svg" alt="PostHog"><img class="logo-dark" src="/logo-white.svg" alt="PostHog">`

function initials(user: User) {
    return user.name
        .split(/\s+/)
        .map((part) => part[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()
}

function userMenu(user: User | null, next: string) {
    if (!user) return html`<a class="ghost" href="/login?next=${encodeURIComponent(next)}">Sign in</a>`
    return html`<a class="avatar" href="/" title="${user.name} (${user.email}) — your artifacts">${initials(user)}</a>`
}

export function appBar({ user, next, center, actions, menu }: { user: User | null; next: string; center?: Html; actions?: Html; menu?: Html }) {
    return html`<header class="bar">
  <a class="brand" href="/">${logo}<span class="product">Artifacts</span></a>
  <span class="sep"></span>
  <div class="title">${center ?? ''}</div>
  <div class="actions">${actions ?? ''}${menu ?? userMenu(user, next)}</div>
</header>`
}

export function relativeTime(ms: number): string {
    const seconds = Math.round((Date.now() - ms) / 1000)
    const units: [number, Intl.RelativeTimeFormatUnit][] = [
        [60, 'second'],
        [60, 'minute'],
        [24, 'hour'],
        [30, 'day'],
        [12, 'month'],
        [Infinity, 'year'],
    ]
    let value = seconds
    for (const [size, unit] of units) {
        if (Math.abs(value) < size) return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-value, unit)
        value = Math.round(value / size)
    }
    return ''
}

const lockIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 1 1 8 0v4"/></svg>'
)
const globeIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
)
const expandIcon = raw(
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
)

const teamIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/></svg>'
)

const mailIcon = raw(
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'
)

export function visibilityPill(visibility: Artifact['visibility']) {
    if (visibility === 'public') return html`<span class="pill public" data-visibility-pill>${globeIcon} Public</span>`
    if (visibility === 'team') return html`<span class="pill team" data-visibility-pill>${teamIcon} PostHog</span>`
    if (visibility === 'invited') return html`<span class="pill invited" data-visibility-pill>${mailIcon} Invited</span>`
    return html`<span class="pill" data-visibility-pill>${lockIcon} Private</span>`
}

export interface CommentsView {
    enabled: boolean
    items: Comment[]
    /** Who the viewer would comment as, or null if they can only read. */
    me: Commenter | null
    owner: boolean
    open: boolean
    error?: string
}

function commentsPanel(artifact: Artifact, { enabled, items, me, owner, open, error }: CommentsView) {
    const canDelete = (c: Comment) => owner || (!!me && c.author_kind === me.kind && c.author_email === me.email)
    return html`<details class="pop" data-close-outside data-comments data-can-comment="${me ? '1' : '0'}" ${open ? 'open' : ''}>
    <summary class="btn secondary"><span>Comments${enabled ? ` (${items.length})` : ''}</span></summary>
    <div class="panel right comments" id="comments">
      <h3>Comments</h3>
      ${owner
          ? html`<form method="post" action="/a/${artifact.id}/comments/settings" class="comment-settings">
        <input type="hidden" name="enabled" value="${enabled ? '0' : '1'}">
        <p class="hint">${enabled ? 'On. ' : 'Off. '}Comments are visible to everyone who can open this artifact and is signed in (PostHog staff, and invited people), never to anonymous link viewers.</p>
        <button class="btn secondary" type="submit"><span>${enabled ? 'Turn comments off' : 'Turn comments on'}</span></button>
      </form>`
          : ''}
      ${enabled
          ? html`${error ? html`<p class="error small">${error}</p>` : ''}
      <ul class="comment-list">
        ${items.length
            ? items.map(
                  (c) => html`<li class="comment" data-comment-id="${c.id}" ${c.anchor_exact ? html`data-exact="${c.anchor_exact}" data-prefix="${c.anchor_prefix ?? ''}" data-suffix="${c.anchor_suffix ?? ''}"` : ''}>
          <div class="row"><strong title="${owner ? c.author_email : ''}">${c.author_name}</strong>
            <span class="muted small">${relativeTime(c.created_at)}${c.version !== artifact.latest_version ? ` · on v${c.version}` : ''}</span></div>
          ${c.anchor_exact
              ? html`<button type="button" class="quote" data-quote="${c.id}" title="Show in the document">“${c.anchor_exact.length > 140 ? c.anchor_exact.slice(0, 140) + '…' : c.anchor_exact}”</button><span class="lost-note small muted">Can't find this text in this version</span>`
              : ''}
          <div class="body">${c.body}</div>
          ${canDelete(c)
              ? html`<form method="post" action="/a/${artifact.id}/comments/${c.id}/delete"><button class="ghost small" type="submit">Delete</button></form>`
              : ''}
        </li>`
              )
            : html`<li class="hint">No comments yet.</li>`}
      </ul>
      ${me
          ? html`<form method="post" action="/a/${artifact.id}/comments" class="stack" data-comment-form>
        <p class="hint">Select text in the document and press Comment to attach a comment to it.</p>
        <div class="composing" data-composing hidden><span class="muted small">Commenting on</span> <q data-composing-text></q> <button type="button" class="ghost small" data-composing-clear>Clear</button></div>
        <input type="hidden" name="anchor_exact"><input type="hidden" name="anchor_prefix"><input type="hidden" name="anchor_suffix">
        <textarea class="text" name="body" rows="3" maxlength="2000" placeholder="Add a comment" aria-label="Comment" required></textarea>
        <button class="btn" type="submit"><span>Post comment</span></button>
      </form>`
          : html`<p class="hint">Sign in to comment.</p>`}`
          : ''}
    </div>
  </details>`
}

// --- Quizzes -----------------------------------------------------------------------

/** Plain text with `backticks` for inline code. Everything is escaped; only the code spans get a tag. */
const inline = (text: string) => text.split('`').map((part, i) => (i % 2 ? html`<code>${part}</code>` : part))

export interface QuizReveal {
    id: string
    prompt: string
    options: { id: string; text: string; chosen: boolean; correct: boolean }[]
    isCorrect: boolean
    explanation?: string
}

export interface QuizView {
    quiz: PublicQuiz
    /** Signed-out takers can type a name; everyone else is known. */
    needsName: boolean
    isLatest: boolean
    owner: boolean
    /** Attempts this person still has on this version: null is unlimited. */
    remaining: number | null
    /** This person's own attempts, newest first. */
    attempts: QuizAttempt[]
    /** Set after submitting: the attempt to show, and (only if the author allows) how each answer fared. */
    result?: { attempt: QuizAttempt; reveal: QuizReveal[] | null }
    error?: string
}

const QUIZ_ERRORS: Record<string, string> = {
    stale: 'This quiz was updated while you had it open. Reload the page and try again.',
    invalid: 'Something was wrong with that submission. Reload the page and try again.',
    limit: "You've used all your attempts.",
    slow: 'Too many submissions. Wait a minute and try again.',
    full: 'This quiz has reached its submission limit.',
    again: 'That submission clashed with another one. Try again.',
}
export const quizErrorMessage = (code: string | undefined) => (code && Object.hasOwn(QUIZ_ERRORS, code) ? QUIZ_ERRORS[code] : undefined)

function scoreCard(attempt: QuizAttempt, passMark: number, preview: boolean) {
    return html`<div class="quiz-score ${attempt.passed ? 'pass' : 'fail'}">
    <div class="big">${attempt.percent}%</div>
    <div><strong>${attempt.passed ? 'Passed' : 'Not passed'}</strong>
      <div class="muted small">${attempt.points} of ${attempt.max_points} points · pass mark ${passMark}%${preview ? ' · your preview, not counted' : ''}</div></div>
  </div>`
}

function questionField(q: PublicQuiz['questions'][number], n: number) {
    const kind = q.type === 'multi' ? 'checkbox' : 'radio'
    return html`<fieldset class="quiz-q">
    <legend><span class="muted">${n + 1}.</span> ${inline(q.prompt)}${q.points > 1 ? html` <span class="muted small">(${q.points} points)</span>` : ''}</legend>
    ${q.type === 'multi' ? html`<p class="hint">Choose all that apply.</p>` : ''}
    ${q.options.map((o) => html`<label class="choice"><input type="${kind}" name="q_${q.id}" value="${o.id}"><span>${inline(o.text)}</span></label>`)}
  </fieldset>`
}

function quizBody(artifact: Artifact, view: QuizView) {
    const { quiz, result, remaining, attempts, owner } = view
    const past = attempts.filter((a) => !result || a.id !== result.attempt.id)
    const form = html`<form method="post" action="/a/${artifact.id}/quiz" class="quiz-form">
    <input type="hidden" name="v" value="${artifact.latest_version}">
    ${quiz.questions.map(questionField)}
    ${view.needsName ? html`<label class="quiz-name"><span class="muted small">Your name (optional)</span><input class="text" name="taker_name" maxlength="60" autocomplete="name"></label>` : ''}
    <button class="btn lg" type="submit"><span>Submit answers</span></button>
    ${remaining !== null && !owner ? html`<p class="hint">${remaining === 1 ? 'You have one attempt.' : `You have ${remaining} attempts.`}</p>` : ''}
  </form>`

    return html`<main class="quiz-wrap"><div class="quiz">
  <h1>${artifact.title}</h1>
  ${quiz.intro ? html`<p class="lede">${inline(quiz.intro)}</p>` : ''}
  ${view.error ? html`<p class="error">${view.error}</p>` : ''}
  ${result
      ? html`${scoreCard(result.attempt, quiz.pass_mark, !!result.attempt.preview)}
  ${result.reveal
      ? html`<h2>Your answers</h2>${result.reveal.map(
            (r, n) => html`<div class="quiz-q reveal ${r.isCorrect ? 'right' : 'wrong'}">
    <p><strong>${n + 1}. ${inline(r.prompt)}</strong> <span class="pill ${r.isCorrect ? 'public' : ''}">${r.isCorrect ? 'Correct' : 'Not quite'}</span></p>
    <ul class="reveal-options">${r.options.map((o) => html`<li class="${o.correct ? 'is-correct' : ''} ${o.chosen ? 'is-chosen' : ''}">${o.chosen ? '● ' : '○ '}${inline(o.text)}${o.correct ? html` <span class="muted small">correct answer</span>` : ''}</li>`)}</ul>
    ${r.explanation ? html`<p class="hint">${inline(r.explanation)}</p>` : ''}
  </div>`
        )}`
      : ''}
  ${view.isLatest && (owner || remaining === null || remaining > 0) ? html`<p><a class="btn secondary" href="/a/${artifact.id}"><span>${owner ? 'Try it again' : 'Try again'}</span></a></p>` : ''}`
      : !view.isLatest
        ? html`<p class="banner-inline">This is an older version. Open the latest version to take the quiz.</p>`
        : !owner && remaining !== null && remaining <= 0
          ? html`<h2>You've used all your attempts</h2><p class="lede">Your most recent result is below.</p>`
          : form}
  ${past.length
      ? html`<h2>Your attempts</h2><table class="list"><thead><tr><th>#</th><th>Score</th><th></th><th class="num">When</th></tr></thead><tbody>${past.map(
            (a) => html`<tr><td>${a.attempt_no}${a.preview ? ' (preview)' : ''}</td><td>${a.percent}% <span class="muted small">${a.points}/${a.max_points}</span></td><td>${a.passed ? html`<span class="pill public">Passed</span>` : html`<span class="pill">Not passed</span>`}</td><td class="num">${relativeTime(a.created_at)}</td></tr>`
        )}</tbody></table>`
      : ''}
</div></main>`
}

export interface QuizResultsView {
    artifact: Artifact
    version: number
    versions: { version: number; n: number }[]
    questions: QuizQuestion[]
    stats: QuestionStats[]
    attempts: QuizAttempt[]
}

export function quizResultsPage({ user, view }: { user: User | null; view: QuizResultsView }) {
    const { artifact, version, versions, questions, stats, attempts } = view
    const passed = attempts.filter((a) => a.passed).length
    const people = new Set(attempts.map((a) => `${a.taker_kind}:${a.taker_id}`)).size
    const avg = attempts.length ? Math.round(attempts.reduce((n, a) => n + a.percent, 0) / attempts.length) : null
    return layout({
        title: `Results · ${artifact.title} · PostHog Artifacts`,
        body: html`${appBar({ user, next: `/a/${artifact.id}/results`, center: html`<h1>${artifact.title}</h1><span class="meta">Quiz results</span>`, actions: html`<a class="btn secondary" href="/a/${artifact.id}"><span>Back to quiz</span></a>` })}
<main class="page">
  <h1>Results</h1>
  <p class="lede">Version ${version}. Your own previews aren't counted.${versions.length > 1 ? html` Other versions: ${versions.filter((v) => v.version !== version).map((v) => html`<a href="/a/${artifact.id}/results?v=${v.version}">v${v.version} (${v.n})</a> `)}` : ''}</p>
  ${attempts.length
      ? html`<div class="card quiz-summary"><div><strong>${attempts.length}</strong><span class="muted small"> ${attempts.length === 1 ? 'attempt' : 'attempts'}</span></div><div><strong>${people}</strong><span class="muted small"> ${people === 1 ? 'person' : 'people'}</span></div><div><strong>${Math.round((passed * 100) / attempts.length)}%</strong><span class="muted small"> passed</span></div><div><strong>${avg}%</strong><span class="muted small"> average</span></div></div>
  <h2>By question</h2>
  ${questions.map(
      (q, n) => html`<div class="card quiz-stat"><p><strong>${n + 1}. ${inline(q.prompt)}</strong></p>
    <p class="muted small">${stats[n]!.answered ? `${Math.round((stats[n]!.correct * 100) / stats[n]!.answered)}% got it right` : 'Not answered yet'} · ${stats[n]!.answered} answered</p>
    <ul class="reveal-options">${q.options.map((o) => html`<li class="${q.correct.includes(o.id) ? 'is-correct' : ''}">${inline(o.text)} <span class="muted small">${stats[n]!.picks[o.id] ?? 0} picked${q.correct.includes(o.id) ? ' · correct' : ''}</span></li>`)}</ul></div>`
  )}
  <h2>Attempts</h2>
  <div class="card flush"><table class="list"><thead><tr><th>Who</th><th>Attempt</th><th>Score</th><th></th><th class="num">When</th></tr></thead><tbody>
  ${attempts.map(
      (a) => html`<tr><td>${a.taker_kind === 'anonymous' ? html`${a.taker_name || 'Anonymous'} <span class="muted small">signed out</span>` : html`${a.taker_name}${a.taker_name !== a.taker_id ? html` <span class="muted small">${a.taker_id}</span>` : ''}${a.taker_kind === 'staff' ? html` <span class="muted small">PostHog</span>` : ''}`}</td><td>${a.attempt_no}</td><td>${a.percent}% <span class="muted small">${a.points}/${a.max_points}</span></td><td>${a.passed ? html`<span class="pill public">Passed</span>` : html`<span class="pill">Not passed</span>`}</td><td class="num">${relativeTime(a.created_at)}</td></tr>`
  )}</tbody></table></div>`
      : html`<div class="card"><div class="empty">No attempts on this version yet.</div></div>`}
</main>`,
    })
}

interface ViewerOptions {
    quiz: QuizView | null
    comments: CommentsView | null
    user: User | null
    /** Email of an invited viewer (not a PostHog user), when that's how this page is being viewed. */
    guest: string | null
    /** The allowlist, shown to the owner only. */
    invites: string[]
    artifact: Artifact
    versions: Version[]
    version: Version
    owner: boolean
    frameSrc: string
    shareUrl: string
}

export function viewerPage({ quiz, comments, user, guest, invites, artifact, versions, version, owner, frameSrc, shareUrl }: ViewerOptions) {
    const isLatest = version.version === artifact.latest_version
    const author = artifact.owner_name ?? artifact.owner_email

    const versionPicker = owner
        ? html`<details class="pop" data-close-outside>
    <summary class="ghost" title="Version history">v${version.version} <span class="muted">of ${artifact.latest_version}</span> ▾</summary>
    <div class="panel left">
      <h3>Version history</h3>
      <p class="hint">Only the latest version is visible to people you share with.</p>
      ${versions.map(
          (v) => html`<a class="version" href="/a/${artifact.id}${v.version === artifact.latest_version ? '' : `?v=${v.version}`}" aria-current="${v.version === version.version}">
        <div class="row"><strong>Version ${v.version}${v.version === artifact.latest_version ? ' · latest' : ''}</strong><span class="muted">${relativeTime(v.created_at)}</span></div>
        ${v.note ? html`<div class="note">${v.note}</div>` : ''}
      </a>`
      )}
    </div>
  </details>`
        : html`<span class="pill hide-sm">v${version.version}</span>`

    const share = owner
        ? html`<details class="pop" data-close-outside>
    <summary class="btn"><span>Share</span></summary>
    <div class="panel right">
      <h3>Share “${artifact.title}”</h3>
      <form data-share-form data-artifact="${artifact.id}">
        <label class="choice">
          <input type="radio" name="visibility" value="private" ${artifact.visibility === 'private' ? 'checked' : ''}>
          <span><strong>Private</strong><small>Only you can view this artifact.</small></span>
        </label>
        <label class="choice">
          <input type="radio" name="visibility" value="team" ${artifact.visibility === 'team' ? 'checked' : ''}>
          <span><strong>PostHog team</strong><small>Anyone signed in with a @posthog.com account can view the latest version. Signed-out visitors can't.</small></span>
        </label>
        <label class="choice">
          <input type="radio" name="visibility" value="invited" ${artifact.visibility === 'invited' ? 'checked' : ''}>
          <span><strong>Specific people</strong><small>Only the emails or company domains you list. They sign in with their own PostHog account (US or EU Cloud).</small></span>
        </label>
        <div class="invite-box" data-invite-box ${artifact.visibility === 'invited' ? '' : 'hidden'}>
          <textarea class="text" rows="3" maxlength="4000" placeholder="ana@acme.com, @acme.com" aria-label="Emails or company domains, separated by commas or new lines" data-invite-list>${invites.join('\n')}</textarea>
          <button class="btn secondary" type="button" data-invite-save><span>Save list</span></button>
        </div>
        <label class="choice">
          <input type="radio" name="visibility" value="public" ${artifact.visibility === 'public' ? 'checked' : ''}>
          <span><strong>Anyone with the link</strong><small>Anyone with the link can view the latest version. Links can't be guessed.</small></span>
        </label>
      </form>
      <div class="copy">
        <input readonly value="${shareUrl}" aria-label="Share link" data-share-link ${artifact.visibility === 'private' ? 'disabled' : ''}>
        <button class="btn secondary" type="button" data-copy ${artifact.visibility === 'private' ? 'disabled' : ''}><span>Copy</span></button>
      </div>
    </div>
  </details>`
        : ''

    const center = html`<h1 title="${artifact.title}">${artifact.title}</h1>
  ${versionPicker}
  ${owner ? visibilityPill(artifact.visibility) : ''}
  ${owner ? (['private', 'team', 'invited', 'public'] as const).map((v) => html`<template data-pill="${v}">${visibilityPill(v)}</template>`) : ''}
  <span class="meta">${owner ? 'Updated' : 'By ' + author + ' ·'} ${relativeTime(isLatest ? artifact.updated_at : version.created_at)}</span>`

    // Links are filled in by viewer.js when the popover opens (POST /a/:id/handover), so they're always fresh.
    const handover = html`<details class="pop" data-close-outside data-handover="${artifact.id}" data-version="${version.version}">
    <summary class="btn secondary" title="Open this artifact in Claude Code or Codex"><span>Open in agent</span></summary>
    <div class="panel right">
      <h3>Hand “${artifact.title}” to an agent</h3>
      <p class="hint">Opens a new session with a prompt that downloads ${isLatest ? 'this artifact' : `version ${version.version}`}. Nothing is sent until you press Enter. The download link works for an hour.</p>
      <a class="agent-option" data-handover-link="claude_code" aria-disabled="true"><strong>Claude Code</strong><small>Opens in a new terminal window.</small></a>
      <a class="agent-option" data-handover-link="codex" aria-disabled="true"><strong>Codex</strong><small>Opens a new chat in the Codex app.</small></a>
      <button class="agent-option" type="button" data-handover-copy disabled><strong>Copy prompt</strong><small>Paste it into any agent.</small></button>
      <p class="hint" data-handover-error hidden>Couldn't prepare the links. Reload the page and try again.</p>
      <p class="hint">Nothing opens? Claude Code needs v2.1.91 or later, and an interactive session sent at least one prompt on this computer. Codex needs the desktop app.</p>
    </div>
  </details>`

    // A quiz is the page itself, not an iframe: no full screen, and its source is the answer key, so only its owner can hand it to an agent.
    const actions = html`${quiz ? '' : html`<button class="ghost hide-sm" type="button" data-fullscreen title="Full screen">${expandIcon}</button>`}
  ${quiz && owner ? html`<a class="btn secondary" href="/a/${artifact.id}/results"><span>Results</span></a>` : ''}
  ${comments ? commentsPanel(artifact, comments) : ''}
  ${quiz && !owner ? '' : handover}
  ${share}`

    return layout({
        title: `${artifact.title} · PostHog Artifacts`,
        description: artifact.description ?? undefined,
        og:
            artifact.visibility === 'public'
                ? { title: artifact.title, description: artifact.description ?? `Shared by ${author}`, url: shareUrl }
                : undefined,
        body: html`<div class="viewer">
${appBar({
    user,
    next: `/a/${artifact.id}`,
    center,
    actions,
    menu: guest
        ? html`<form method="post" action="/a/${artifact.id}/signout"><button class="ghost" type="submit" title="Signed in as ${guest}">Sign out</button></form>`
        : undefined,
})}
${!isLatest
    ? html`<div class="banner">You're viewing version ${version.version}. People you share with only see the latest. <a href="/a/${artifact.id}">View latest (v${artifact.latest_version})</a></div>`
    : ''}
${quiz
    ? quizBody(artifact, quiz)
    : html`<iframe src="${frameSrc}" title="${artifact.title}" ${version.format === 'slides' ? raw('data-autofocus') : ''} sandbox="${SANDBOX}" allow="clipboard-write; fullscreen" referrerpolicy="no-referrer"></iframe>`}
</div>
<div class="toast" role="status" aria-live="polite"></div>
<script src="/viewer.js" defer></script>`,
    })
}

export function guestGatePage({ id, error, signedInAs }: { id: string; error?: string; signedInAs?: string }) {
    // Nothing here names the artifact or its author: the page looks the same for every invited artifact.
    if (signedInAs) {
        return layout({
            title: 'No access · PostHog Artifacts',
            body: html`${appBar({ user: null, next: `/a/${id}`, menu: html`` })}
<main class="page narrow">
  <h1>You don't have access to this document</h1>
  <p class="lede">You're signed in as <strong>${signedInAs}</strong>, which isn't on the list of people it was shared with. Ask whoever sent you the link to add your address.</p>
  <form method="post" action="/a/${id}/signout">
    <button class="btn secondary" type="submit"><span>Use a different account</span></button>
  </form>
  <p class="small muted spaced">To pick another PostHog account, you may also need to sign out of PostHog first.</p>
</main>`,
        })
    }
    return layout({
        title: 'View document · PostHog Artifacts',
        body: html`${appBar({ user: null, next: `/a/${id}`, menu: html`` })}
<main class="page narrow">
  <h1>Sign in to view this document</h1>
  <p class="lede">This was shared with specific people. Sign in with your PostHog account to continue.</p>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <div class="stack">
    <a class="btn lg" href="/a/${id}/signin/us"><span>Continue with PostHog US Cloud</span></a>
    <a class="btn lg secondary" href="/a/${id}/signin/eu"><span>Continue with PostHog EU Cloud</span></a>
  </div>
  <p class="small muted spaced">Use the account whose email address the document was shared with. You'll only see it if that address is on the list.</p>
</main>`,
    })
}

export function homePage({ user, artifacts, publicUrl }: { user: User | null; artifacts: Artifact[]; publicUrl: string }) {
    const setup = html`<div class="card">
  <strong>Connect Claude Code</strong>
  <p class="small muted tight">Install the plugin to get the MCP server and the <code>/share-artifact</code> skill:</p>
  <pre class="snippet">/plugin marketplace add PostHog/artifacts
/plugin install posthog-artifacts@posthog-artifacts</pre>
  <p class="small muted spaced">Or just add the MCP server to any MCP client:</p>
  <pre class="snippet">claude mcp add --transport http posthog-artifacts ${publicUrl}/mcp</pre>
</div>`

    if (!user) {
        return layout({
            title: 'PostHog Artifacts',
            og: { title: 'PostHog Artifacts', description: 'Things we made with Claude, shared.', url: publicUrl },
            body: html`${appBar({ user, next: '/' })}
<main class="page">
  <h1>Artifacts</h1>
  <p class="lede">A place for the reports, write-ups and pages we make with Claude. Publish from any Claude session, share with a link.</p>
  <div class="row-actions hero-actions"><a class="btn lg" href="/auth/posthog"><span>Sign in with PostHog</span></a><span class="small muted">PostHog staff only</span></div>
  ${setup}
</main>`,
        })
    }

    return layout({
        title: 'Your artifacts · PostHog Artifacts',
        body: html`${appBar({ user, next: '/', actions: html`<form method="post" action="/logout"><button class="ghost" type="submit">Sign out</button></form>` })}
<main class="page">
  <h1>Your artifacts</h1>
  <p class="lede">Everything you've published. Ask Claude to publish or update one, or use <code>/share-artifact</code>.</p>
  <div class="card flush">
  ${artifacts.length
      ? html`<table class="list">
    <thead><tr><th>Title</th><th class="hide-sm">Access</th><th class="num hide-sm">Version</th><th class="num">Updated</th></tr></thead>
    <tbody>
    ${artifacts.map(
        (a) => html`<tr>
      <td><a href="/a/${a.id}">${a.title}</a>${a.description ? html`<div class="small muted">${a.description}</div>` : ''}</td>
      <td class="hide-sm">${visibilityPill(a.visibility)}</td>
      <td class="num hide-sm">v${a.latest_version}</td>
      <td class="num">${relativeTime(a.updated_at)}</td>
    </tr>`
    )}
    </tbody>
  </table>`
      : html`<div class="empty">Nothing here yet. In Claude Code, try <code>/share-artifact</code>.</div>`}
  </div>
  <h2>Setup</h2>
  ${setup}
</main>`,
    })
}

export function loginPage({ next, error, dev }: { next: string; error?: string; dev: boolean }) {
    return layout({
        title: 'Sign in · PostHog Artifacts',
        body: html`${appBar({ user: null, next })}
<main class="page narrow">
  <h1>Sign in</h1>
  <p class="lede">Use your PostHog account. Only verified @posthog.com emails can sign in.</p>
  ${error ? html`<p class="error">${error}</p>` : ''}
  <div class="stack">
    <a class="btn lg" href="/auth/posthog?next=${encodeURIComponent(next)}"><span>Continue with PostHog</span></a>
    ${dev
        ? html`<form class="card stack" method="post" action="/login/dev">
      <strong>Local dev login</strong>
      <input type="hidden" name="next" value="${next}">
      <input class="text" name="email" type="email" placeholder="you@posthog.com" required>
      <input class="text" name="name" placeholder="Your name">
      <button class="btn" type="submit"><span>Sign in (dev only)</span></button>
    </form>`
        : ''}
  </div>
</main>`,
    })
}

export function consentPage({ user, details, handle }: { user: User; details: ConsentDescription; handle: string }) {
    return layout({
        title: 'Connect · PostHog Artifacts',
        body: html`${appBar({ user, next: '/' })}
<main class="page narrow">
  <h1>Connect ${details.clientName}?</h1>
  <p class="lede">${details.clientDomain
      ? html`Published by <strong>${details.clientDomain}</strong>.`
      : 'This app registered itself; its name is not verified.'}
  It will be able to publish, update, share and delete artifacts as <strong>${user.email}</strong>.</p>
  <div class="card stack">
    <div class="small">Access will be sent to <strong>${details.redirectHost}</strong>.</div>
    ${details.redirectIsLoopback
        ? html`<div class="small"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it (for example Claude Code).</div>`
        : ''}
    <form method="post" action="/authorize" class="row-actions">
      <input type="hidden" name="handle" value="${handle}">
      <input type="hidden" name="scope" value="artifacts">
      <button class="btn" name="decision" value="approve"><span>Allow</span></button>
      <button class="btn secondary" name="decision" value="deny"><span>Deny</span></button>
    </form>
  </div>
</main>`,
    })
}

export function messagePage({ user, title, message, status }: { user: User | null; title: string; message: string; status?: number }) {
    return layout({
        title: `${title} · PostHog Artifacts`,
        body: html`${appBar({ user, next: '/' })}
<main class="page narrow">
  <h1>${title}</h1>
  <p class="lede">${message}</p>
  ${status === 404 && !user ? html`<a class="btn" href="/login"><span>Sign in</span></a>` : html`<a class="btn secondary" href="/"><span>Back to artifacts</span></a>`}
</main>`,
    })
}
