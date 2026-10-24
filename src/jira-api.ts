// Jira Cloud REST client for the user's own tickets (API token auth). Read-only: it only searches.
import type { JiraIssue } from "./jira-sync.js";

export const SYNC_FIELDS = [
  "summary", "status", "statuscategorychangedate", "resolutiondate", "created", "updated",
  "parent", "issuetype", "assignee", "description",
];

export interface JiraAuth { site: string; email: string; token: string }

export const jiraConfigured = (a: JiraAuth) => !!(a.site && a.email && a.token);

function checkSite(site: string) {
  const u = new URL(site);
  // https only; plain http is allowed for a local mock (tests) and nothing else.
  if (u.protocol !== "https:" && !(u.protocol === "http:" && u.hostname === "127.0.0.1")) {
    throw new Error(`JIRA_SITE must be https: ${site}`);
  }
}

/** All issues matching `jql`, following nextPageToken (enhanced search API). */
export async function searchAll(auth: JiraAuth, jql: string, fields = SYNC_FIELDS): Promise<JiraIssue[]> {
  if (!jiraConfigured(auth)) throw new Error("Jira API not configured: set JIRA_EMAIL and JIRA_API_TOKEN in brain-server\\.env");
  checkSite(auth.site);
  const headers = {
    Authorization: `Basic ${Buffer.from(`${auth.email}:${auth.token}`).toString("base64")}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  const issues: JiraIssue[] = [];
  let nextPageToken: string | undefined;
  for (let page = 0; page < 50; page++) { // hard stop: 5,000 issues
    const res = await fetch(`${auth.site}/rest/api/3/search/jql`, {
      method: "POST", headers, signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) }),
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Jira rejected the credentials (${res.status}): check JIRA_EMAIL and JIRA_API_TOKEN`);
    }
    if (!res.ok) throw new Error(`Jira search failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    const body = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
    issues.push(...(body.issues ?? []));
    nextPageToken = body.nextPageToken;
    if (!nextPageToken || body.isLast === true) return issues;
  }
  return issues;
}
