# Ticket notes: how the `jira*` skills write to the Work brain

The four `jira*` skills in `C:\Users\jehu.casimiro\.claude\skills\` end by calling this procedure.

## Preferred: the `work-brain` MCP tools

When the `work-brain` MCP tools are available:

1. `get_note` with the Jira key. If it exists, read it so tags/links and other sections are known.
2. `search` for the main modules/features you touched, so `links` point at existing module/feature/calc notes.
3. `write_note` with `type: "ticket"`, `ext_id: <KEY>`, `title`, `date` (today; ignored if the note exists), `status`, `source: "jira"`, `tags`, `links`, `commit_sha` when known, and `body` holding **only the `## ` sections this skill owns**. The server keeps the original date, merges tags/links, leaves other sections and hand edits alone, and indexes the note. No reindex step needed.

The rules below (frontmatter meanings, section content, local only, report line) still apply.

## Fallback: write the file directly

If the MCP tools aren't available in the session, edit the file as follows, then reindex.

**Local only.** These notes stay on this laptop: never paste them into Jira, a PR, or any external service.

## Where

- Vault: `C:\Users\jehu.casimiro\work-brain\work-vault`
- File: `tickets\<yyyy>\<KEY>.md`, where `<yyyy>` is the year of the note's `date`.
- One note per Jira key. Before creating, look for an existing `tickets\*\<KEY>.md` and update that one.

## Frontmatter

```yaml
---
brain: work
type: ticket
id: SMS-1011            # verified Jira key, exactly once
title: <Jira summary, verbatim>
date: YYYY-MM-DD        # day the note was first created; never change it afterwards
updated: YYYY-MM-DD     # today, on every write
status: <Jira status name, verbatim, e.g. "Done in BRANCH">
source: jira
commit_sha: <latest milestone commit, once one exists>
tags: [<2–5 lowercase-hyphenated topics from the analysis, e.g. events-planner, work-requests>]
links: [<parent epic key>, <linked issue keys>, <module/feature/calc slugs>]
---
```

Rules: keep the Jira status name exactly as Jira shows it (statuses are custom). Put the parent epic and linked issue keys in `links`. Jira labels/components are often empty, so derive tags from the analysis. Merge `tags`/`links` with what's already there; don't drop entries.

## Body

Always these five sections, in this order (from `work-vault\_templates\ticket.md`):

```markdown
## Summary
## What changed
## Why
## Modules touched
## Follow-ups
```

Each skill updates **only the sections it owns** (listed in that skill), replacing that section's previous content with the current state. Leave other sections and any hand-written text untouched. Missing sections: add them empty in the order above.

Write facts the next session will want, not the full report: 2–6 short lines or bullets per section. Paths as repo-relative `path/to/file.ts`; no code dumps. If ticket comments changed the requirement, the Summary describes the requirement **as revised**, and says so.

## Reindex

```powershell
npm --prefix C:\Users\jehu.casimiro\work-brain\brain-server run -s reindex
```

Expect `indexed 1` (or `unchanged 1`). A `skipped` count means the frontmatter failed validation: read the warning, fix the note, rerun.

## Report

End the skill's response with one line: `Brain: updated tickets/<yyyy>/<KEY>.md (<sections>)`. If writing failed, say so; it never blocks or undoes the skill's main work.
