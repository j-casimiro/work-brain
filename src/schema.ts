import { z } from "zod";

export const BRAINS = ["work", "masters", "teaching"] as const;
export const NOTE_TYPES = ["ticket", "journal", "decision", "module", "feature", "calc"] as const;
export type Brain = (typeof BRAINS)[number];
export type NoteType = (typeof NOTE_TYPES)[number];
export const EPISODIC: NoteType[] = ["ticket", "journal", "decision"];

// YAML turns bare 2026-10-24 into a Date; normalise back to YYYY-MM-DD.
const isoDate = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD"),
);
const optStr = z.preprocess((v) => (v == null || v === "" ? undefined : String(v)), z.string().optional());
const strList = z.preprocess((v) => (v == null ? [] : v), z.array(z.coerce.string()));

/** Frontmatter as it appears in a vault file. */
export const Frontmatter = z.object({
  brain: z.enum(BRAINS),
  type: z.enum(NOTE_TYPES),
  id: z.coerce.string().min(1),
  title: z.coerce.string().min(1),
  date: isoDate,
  updated: isoDate.optional(),
  status: optStr,
  source: optStr,
  commit_sha: optStr,
  done: isoDate.optional(), // tickets: day dev implementation/fix finished (PR made, or marked done)
  assignee: optStr, // tickets: Jira assignee display name
  tags: strList,
  links: strList,
});
export type Frontmatter = z.infer<typeof Frontmatter>;

/** Body of POST /memories (used by the writer in step 5). */
export const WritePayload = z
  .object({
    brain: z.enum(BRAINS),
    type: z.enum(NOTE_TYPES),
    ext_id: z.string().min(1).regex(/^[A-Za-z0-9._-]+$/, "ext_id must be filename-safe"),
    date: isoDate,
    title: z.string().min(1),
    summary: z.string().default(""),
    body: z.string().default(""),
    links: z.array(z.string()).default([]),
    tags: z.array(z.string()).default([]),
    status: z.string().optional(),
    source: z.string().default("agent"),
    commit_sha: z.string().optional(),
    assignee: z.string().optional(),
    updated: isoDate.optional(), // default today; jira-sync passes the ticket's own last-activity date
  })
  .strict();
export type WritePayload = z.infer<typeof WritePayload>;
