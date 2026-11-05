/**
 * Jira: a fake Jira Cloud on this machine, the real backend process, and the assistant's Jira tools.
 *
 * What must hold: a connection is proven before it is saved and its token never comes back; only Jira Cloud
 * addresses are accepted; a project links to a key that exists; the tools never reach outside the linked key -
 * not by asking for another ticket, not by search results Jira returns; writes go to Jira as asked.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fromAdf, jiraSite, jiraTools, toAdf } from "../src/jira.js";

const PORT = 8783, JIRA_PORT = 8784;
const B = `http://127.0.0.1:${PORT}`, JIRA = `http://127.0.0.1:${JIRA_PORT}`;
const ROOT = "root-key-for-the-jira-test";
const EMAIL = "me@example.com", TOKEN = "atlassian-api-token-123";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "lc-jira-"));

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? "ok " : "FAIL"} ${what}`); if (!cond) failed++; };

/* ---------------------------------------------------------------- a fake Jira Cloud */
const created: any[] = [], comments: any[] = [], moved: any[] = [];
let lastJql = "";
const issue = (key: string, summary: string, status = "To Do") => ({ key, fields: { summary, status: { name: status }, issuetype: { name: "Task" }, priority: { name: "Medium" }, assignee: null, labels: [], updated: "2026-11-05T10:00:00.000+0000",
  description: toAdf("First paragraph.\n\n- one\n- two"), comment: { comments: [{ author: { displayName: "Ana" }, created: "2026-11-05", body: toAdf("Looks good.") }] } } });
const jira = http.createServer((req, res) => {
  const reply = (status: number, body: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  if (req.headers.authorization !== "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")) return reply(401, { errorMessages: ["Unauthorized"] });
  const u = new URL(req.url ?? "/", JIRA);
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const b = body ? JSON.parse(body) : {};
    if (u.pathname === "/rest/api/3/myself") return reply(200, { accountId: "a1", displayName: "Me Myself" });
    if (u.pathname === "/rest/api/3/project/ACME") return reply(200, { key: "ACME", name: "Acme maintenance", issueTypes: [{ name: "Task" }, { name: "Bug" }, { name: "Sub-task", subtask: true }] });
    if (u.pathname.startsWith("/rest/api/3/project/") && !u.pathname.endsWith("/search")) return reply(404, { errorMessages: ["No project could be found"] });
    if (u.pathname === "/rest/api/3/project/search") return reply(200, { values: [{ key: "ACME", name: "Acme maintenance" }, { key: "OTHER", name: "Other team" }] });
    if (u.pathname === "/rest/api/3/search/jql") {
      lastJql = u.searchParams.get("jql") ?? "";
      // A Jira that answers with a ticket of another project too: the tool must drop it.
      return reply(200, { issues: [issue("ACME-1", "Fix footer"), issue("OTHER-9", "Secret thing")] });
    }
    const im = u.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/comment|\/transitions)?$/);
    if (im && req.method === "GET" && !im[2]) return reply(200, issue(im[1], "Fix footer"));
    if (im && im[2] === "/comment") { comments.push({ key: im[1], text: fromAdf(b.body).trim() }); return reply(201, { id: "c1" }); }
    if (im && im[2] === "/transitions" && req.method === "GET") return reply(200, { transitions: [{ id: "21", name: "Start", to: { name: "In Progress" } }, { id: "31", name: "Finish", to: { name: "Done" } }] });
    if (im && im[2] === "/transitions") { moved.push({ key: im[1], id: b.transition?.id }); return reply(204, null); }
    if (u.pathname === "/rest/api/3/issue" && req.method === "POST") { created.push(b.fields); return reply(201, { id: "100", key: "ACME-2" }); }
    reply(404, { errorMessages: ["not in the fake"] });
  });
});
await new Promise<void>((r) => jira.listen(JIRA_PORT, "127.0.0.1", () => r()));

/* ---------------------------------------------------------------- the backend */
fs.mkdirSync(path.join(data, "sites"), { recursive: true });
fs.writeFileSync(path.join(data, "sites", "site_one.json"), JSON.stringify({ id: "site_one", name: "Site One", url: "http://127.0.0.1:1/one", username: "u", appPassword: "p", createdAt: new Date().toISOString() }));
const server = spawn(process.execPath, ["server.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LC_DATA_DIR: data, LC_API_TOKEN: ROOT, LC_VERIFY_CHANGES: "0", LC_JIRA_TEST_URL: JIRA },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));
const call = async (method: string, p: string, body?: unknown) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${ROOT}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/health")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }

  console.log("addresses");
  ok(jiraSite("acme") === "https://acme.atlassian.net" && jiraSite("https://acme.atlassian.net/jira/software/projects/X") === "https://acme.atlassian.net", "a team name or any Jira Cloud link becomes its site");
  ok(jiraSite("http://169.254.169.254") === null && jiraSite("https://evil.example.com") === null && jiraSite("acme.atlassian.net.evil.com") === null, "anything else is refused (no calls into a private network)");
  ok(fromAdf(toAdf("Hello\n\n- a\n- b")).includes("- a") && fromAdf(toAdf("Hello")).trim() === "Hello", "plain text survives the trip to Jira's document format and back");

  console.log("connecting");
  ok((await call("PUT", "/auth/jira", { siteUrl: "https://evil.example.com", email: EMAIL, token: TOKEN })).status === 400, "a non-Jira address is refused");
  ok((await call("PUT", "/auth/jira", { siteUrl: JIRA, email: EMAIL, token: "wrong" })).status === 400, "a wrong token is refused (Jira said no) and not saved");
  ok((await call("GET", "/auth/jira")).body?.connected === false, "nothing was saved");
  let s = await call("PUT", "/auth/jira", { siteUrl: JIRA, email: EMAIL, token: TOKEN });
  ok(s.status === 200 && s.body.accountName === "Me Myself", "the right token connects, named as Jira knows the person");
  s = await call("GET", "/auth/jira");
  ok(s.body.connected && !JSON.stringify(s.body).includes(TOKEN), "the token is never sent back");
  ok((await call("GET", "/auth/jira/projects")).body?.projects?.length === 2, "the person's Jira projects are listed for the picker");

  console.log("linking a project");
  const prj = (await call("GET", "/projects")).body[0];
  ok((await call("PATCH", `/projects/${prj.id}`, { jira: { projectKey: "NOPE" } })).status === 400, "a key that does not exist is refused");
  s = await call("PATCH", `/projects/${prj.id}`, { jira: { projectKey: "acme" } });
  ok(s.status === 200 && s.body.jira?.projectKey === "ACME" && s.body.jira.projectName === "Acme maintenance", "a real key links, with Jira's name for it");
  s = await call("GET", `/admin/prompt?site=site_one&project=${prj.id}`);
  ok(s.body?.text?.includes("Jira project ACME"), "the assistant is told which Jira project it works in");

  console.log("the assistant's tools");
  const t = jiraTools({ connection: { siteUrl: JIRA, email: EMAIL, token: TOKEN }, projectKey: "ACME" }) as any;
  const run = (name: string, input: unknown) => t[name].execute(input, { toolCallId: "x", messages: [] });
  let r = await run("jira_search", { text: 'footer" OR project = OTHER', open: true });
  ok(r.ok && r.issues.length === 1 && r.issues[0].key === "ACME-1", "search returns only ACME tickets, even when Jira sends others");
  ok(lastJql.startsWith('project = "ACME"') && !lastJql.includes('"footer" OR'), "the words cannot break out of the query");
  r = await run("jira_get_issue", { issue: "OTHER-9" });
  ok(!r.ok && /not in this project/.test(r.error), "a ticket of another project is refused");
  r = await run("jira_get_issue", { issue: "acme-1" });
  ok(r.ok && r.issue.description.includes("- one") && r.issue.comments[0].text === "Looks good.", "a ticket is read with its description and comments as text");
  r = await run("jira_create_issue", { summary: "Update footer year", description: "Change 2025 to 2026.\n\n- desktop\n- mobile", issueType: "Bug", labels: ["amc 2026"] });
  ok(r.ok && r.created.key === "ACME-2" && created[0].project.key === "ACME" && created[0].issuetype.name === "Bug" && created[0].labels[0] === "amc-2026", "a ticket is created in ACME only, as asked");
  r = await run("jira_comment", { issue: "ACME-1", text: "Done on the draft, waiting for deploy." });
  ok(r.ok && comments[0].text === "Done on the draft, waiting for deploy.", "a comment is added");
  r = await run("jira_move_issue", { issue: "ACME-1", to: "Blocked" });
  ok(!r.ok && /In Progress, Done/.test(r.error), "an impossible move says where the ticket can go");
  r = await run("jira_move_issue", { issue: "ACME-1", to: "in progress" });
  ok(r.ok && moved[0].id === "21", "a ticket moves by the status name");

  console.log("disconnecting");
  ok((await call("DELETE", "/auth/jira")).body?.connected === false && (await call("GET", "/auth/jira")).body.connected === false, "disconnecting forgets the token");
} finally {
  server.kill(); jira.close();
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) FAILED\n--- server output ---\n${out.slice(-3000)}`); process.exit(1); }
console.log("\nall Jira checks passed");
