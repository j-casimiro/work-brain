import crypto from "node:crypto";
import matter from "gray-matter";
import { Frontmatter } from "./schema.js";

export const sha1 = (s: string) => crypto.createHash("sha1").update(s).digest("hex");

export interface Chunk { ord: number; heading: string; body: string; hash: string }
export interface ParsedNote { fm: Frontmatter; body: string; chunks: Chunk[]; links: string[] }

/** "[[discount-calc|the calc]]" / "[[pricing#Tiers]]" -> "discount-calc" / "pricing" */
export function normaliseLink(raw: string): string {
  return raw.replace(/^\[\[|\]\]$/g, "").split("|")[0].split("#")[0].trim();
}

/** Split a markdown body into one chunk per heading section (ignores # inside code fences). */
export function chunkByHeading(body: string, fallbackHeading: string): Chunk[] {
  const sections: { heading: string; lines: string[] }[] = [{ heading: fallbackHeading, lines: [] }];
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^#{1,6}\s+(.*)$/);
    if (h) sections.push({ heading: h[1].trim(), lines: [] });
    else sections[sections.length - 1].lines.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, body: s.lines.join("\n").trim() }))
    .filter((s) => s.body.length > 0)
    .map((s, ord) => ({ ord, ...s, hash: sha1(`${s.heading}\n${s.body}`) }));
}

export function parseNote(raw: string): ParsedNote {
  const { data, content } = matter(raw);
  const fm = Frontmatter.parse(data);
  const inline = [...content.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => normaliseLink(m[1]));
  const links = [...new Set([...fm.links.map(normaliseLink), ...inline].filter(Boolean))];
  // Chunk 0 always carries id/title/tags so exact lookups ("PROJ-1423") hit even when the body never names them.
  const sections = chunkByHeading(content, fm.title);
  const preamble = sections[0]?.heading === fm.title ? sections.shift()!.body : "";
  const head = [`${fm.id} — ${fm.title}`, fm.tags.length ? `tags: ${fm.tags.join(", ")}` : "", preamble].filter(Boolean).join("\n");
  const chunks = [{ heading: fm.title, body: head }, ...sections].map((c, ord) => ({
    ord, heading: c.heading, body: c.body, hash: sha1(`${c.heading}\n${c.body}`),
  }));
  return { fm, body: content, chunks, links };
}
