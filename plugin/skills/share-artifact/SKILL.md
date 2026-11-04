---
name: share-artifact
description: Publish output from this Claude session (a report, analysis, write-up, HTML page or Markdown doc) to artifacts.posthog.com and return a link. Use when the user says "share this", "publish this", "make this an artifact", "give me a link to this", "/share-artifact", or asks to update, re-publish, share, unshare or delete an artifact they published before.
---

# Share an artifact

Artifacts live at `artifacts.posthog.com`. Each one has an unguessable link, keeps every version, and is **private** until the owner shares it, with the **PostHog team** (anyone signed in with a @posthog.com account), with **specific people** outside PostHog (an email allowlist; they sign in with their own PostHog account), or **publicly** (anyone with the link). Only the latest version is ever visible to people it's shared with.

You publish through the `posthog-artifacts` MCP server (tools: `publish_artifact`, `list_artifacts`, `get_artifact`, `set_visibility`, `update_artifact`, `delete_artifact`). If those tools are missing, tell the user to run:

```
claude mcp add --transport http posthog-artifacts https://artifacts.posthog.com/mcp
```

then `/mcp` to sign in with their PostHog account, and stop.

## 1. Decide what to publish

- If the user named or pointed at something (a file, the last answer, "the report"), publish exactly that.
- Otherwise, publish the main deliverable of this session, not the conversation itself. A session that produced an analysis becomes the analysis. A session that changed code becomes a short write-up: what changed, why, and how to verify it.
- If two or more things could fit, ask the user which one in one short question.

## 2. Pick a format

- **markdown** is for prose: write-ups, notes, plans, summaries. The site renders it with PostHog typography.
- **html** is for anything visual or interactive: charts, dashboards, tables you can sort, designed pages. Send one complete, self-contained document. Inline the CSS and JS. External scripts may only come from public CDNs, with pinned versions.
- HTML runs in a sandboxed iframe with an opaque origin, so `localStorage`, cookies and same-origin requests are unavailable. Wrap storage access in `try/catch`, or skip it.
- The limit is 5 MB. Don't embed large images as base64. Link to them instead.

## 3. Scrub before you publish

Publishing sends content out of this session. Before you call the tool, remove these:

- secrets, API keys, tokens, passwords, connection strings
- customer personal data (emails, names of end users, IPs) unless the user explicitly asked to include it
- internal file paths and hostnames that the reader doesn't need

If you removed something meaningful, say so in your reply.

## 4. Create or update

- **Update by default.** If this session already published an artifact for the same thing, call `publish_artifact` with its `artifact_id` and a short `note` saying what changed. This keeps one link and adds a version. If you're unsure whether one exists, check `list_artifacts`.
- **New artifact:** call `publish_artifact` without `artifact_id`. Give it a specific `title` (for example "Q3 churn analysis: EU self-serve", not "Report") and a one-sentence `description`. The description shows in link previews.
- Leave `visibility` unset, so the artifact stays private, unless the user asked you to share it.
  - "Share it", "share with the team", "send to <a colleague>", "post it in Slack": pass `visibility: "team"`. Only PostHog staff can open it.
  - "Share with <a customer>", "send to ana@acme.com", "give Acme access": pass `visibility: "invited"` and `invited_emails` with their addresses (or `@acme.com` for everyone at a company the user names). They open the link and sign in with their PostHog account, so the addresses must be the ones on their PostHog accounts. Never invent addresses: ask the user who should have access. Consumer domains such as `@gmail.com` can't be listed, so list individual addresses.
  - "Make it public", "anyone with the link": pass `visibility: "public"`. Anyone with the link can open it, so check the content is fine for outsiders (no internal-only data) first.
  - If it's unclear whether people outside PostHog need it, use `"team"`. Prefer `"invited"` over `"public"` for anything customer-specific.

## 5. Report back

Reply with:

- the link, from `url` in the tool result
- its access, one of:
  - "Private: only you can see it. Use the Share button on the page, or ask me, to share it."
  - "PostHog team: anyone signed in with a @posthog.com account can see the latest version."
  - "Invited: only <the addresses>. They sign in with their own PostHog account."
  - "Public: anyone with the link can see the latest version."
- the version number, if this was an update

Keep it to two or three lines.

## Managing artifacts

- Share or unshare: `set_visibility` with `"team"`, `"invited"` (plus `invited_emails`, which replaces the list), `"public"` or `"private"`. To add one person, send the full list again. The change takes effect immediately, and links that are already open stop working.
- Rename: `update_artifact`.
- Look at the history or an old version: `get_artifact` with `version` and `include_content: true`.
- Delete: `delete_artifact`. It is permanent and breaks the link for everyone. Confirm with the user first, every time.
