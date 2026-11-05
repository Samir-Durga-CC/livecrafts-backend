/**
 * Documents (an AMC): a real backend process, a fake OpenAI-compatible model, a fake Jira, and real PDF / Word files.
 *
 * What must hold: only PDF / Word / text is taken; the text is read out of a real PDF and a real .docx; the analysis
 * runs in the background and a reply that is not the asked-for JSON is asked for again; its cost is counted; tickets
 * are filed only when asked, once per task, in the project's Jira key, as the person; a site task becomes a session
 * in the project; a client cannot touch documents.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";

const PORT = 8786, MODEL_PORT = 8787, JIRA_PORT = 8788;
const B = `http://127.0.0.1:${PORT}`;
const ROOT = "root-key-for-the-documents-test";
const EMAIL = "me@example.com", TOKEN = "jira-token-docs";
const data = fs.mkdtempSync(path.join(os.tmpdir(), "lc-docs-"));

let failed = 0;
const ok = (cond: unknown, what: string) => { console.log(`  ${cond ? "ok " : "FAIL"} ${what}`); if (!cond) failed++; };

/* ---------------------------------------------------------------- the files */
/** A real one-page PDF with real text (hand-written objects; pdf.js reads it). */
function pdfWith(lines: string[]): Buffer {
  const content = ["BT", "/F1 11 Tf", "72 760 Td", ...lines.flatMap((l, i) => [i ? "0 -16 Td" : "", `(${l.replace(/[()\\]/g, "")}) Tj`]).filter(Boolean), "ET"].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n"; const at: number[] = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => String(n).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
async function docxWith(paras: string[]): Promise<Buffer> {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  z.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);
  return z.generateAsync({ type: "nodebuffer" });
}
const AMC = ["Annual Maintenance Contract between Acme Ltd and Craft Agency", "Period: 1 January 2026 to 31 December 2026",
  "The agency updates WordPress plugins and core every month.", "The agency sends a monthly uptime report to Acme.", "Critical issues are answered within 4 hours.", "Not covered: new page designs."];

/* ---------------------------------------------------------------- a fake model (OpenAI chat completions) */
const ANALYSIS = { summary: "A one-year AMC between Acme Ltd and Craft Agency for 2026. Covers monthly updates, a monthly report and a 4-hour response to critical issues. New designs are not covered.",
  contract: { client: "Acme Ltd", provider: "Craft Agency", period: "2026-01-01 to 2026-12-31", services: ["Monthly plugin and core updates", "Monthly uptime report"], responseTimes: ["Critical: 4 hours"], exclusions: ["New page designs"] },
  tasks: [
    { title: "Update plugins and WordPress core", detail: "Every month.", kind: "site", frequency: "monthly", priority: "medium", source: "updates WordPress plugins and core every month" },
    { title: "Send the monthly uptime report", detail: "", kind: "ticket", frequency: "monthly", priority: "medium", source: "sends a monthly uptime report" },
    { title: "Answer critical issues within 4 hours", detail: "", kind: "ticket", frequency: "on request", priority: "high", source: "answered within 4 hours" },
  ] };
let modelCalls = 0;
const prompts: string[] = [];
const model = http.createServer((req, res) => {
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    const b = JSON.parse(body || "{}");
    const prompt = JSON.stringify(b.messages ?? []);
    prompts.push(prompt);
    modelCalls++;
    // The first analysis answer is prose with no JSON: the backend must ask again.
    const text = /maintenance contract/.test(prompt) ? (modelCalls === 1 ? "Here is what I found: lots of tasks!" : "```json\n" + JSON.stringify(ANALYSIS) + "\n```") : "I looked at the site. Nothing to change yet.";
    const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 };
    if (b.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: b.model, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: b.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "c", object: "chat.completion", created: 1, model: b.model, choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }], usage }));
  });
});

/* ---------------------------------------------------------------- a fake Jira */
const filed: any[] = [];
const jira = http.createServer((req, res) => {
  const reply = (s: number, b: unknown) => { res.writeHead(s, { "Content-Type": "application/json" }); res.end(JSON.stringify(b)); };
  if (req.headers.authorization !== "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")) return reply(401, {});
  let body = ""; req.on("data", (d) => (body += d)); req.on("end", () => {
    if (req.url === "/rest/api/3/myself") return reply(200, { displayName: "Me" });
    if (req.url === "/rest/api/3/project/ACME") return reply(200, { key: "ACME", name: "Acme", issueTypes: [{ name: "Task" }] });
    if (req.url === "/rest/api/3/issue" && req.method === "POST") { filed.push(JSON.parse(body).fields); return reply(201, { key: `ACME-${filed.length}` }); }
    reply(404, {});
  });
});
await new Promise<void>((r) => model.listen(MODEL_PORT, "127.0.0.1", () => r()));
await new Promise<void>((r) => jira.listen(JIRA_PORT, "127.0.0.1", () => r()));

/* ---------------------------------------------------------------- the backend */
fs.mkdirSync(path.join(data, "sites"), { recursive: true });
fs.writeFileSync(path.join(data, "sites", "site_one.json"), JSON.stringify({ id: "site_one", name: "Site One", url: "http://127.0.0.1:1/one", username: "u", appPassword: "p", createdAt: new Date().toISOString() }));
const server = spawn(process.execPath, ["server.js"], {
  cwd: path.resolve(import.meta.dirname, ".."),
  env: { ...process.env, PORT: String(PORT), HOST: "127.0.0.1", LC_DATA_DIR: data, LC_API_TOKEN: ROOT, LC_VERIFY_CHANGES: "0",
    LC_MODEL: "custom:fake-model", LC_CUSTOM_BASE_URL: `http://127.0.0.1:${MODEL_PORT}/v1`, LC_JIRA_TEST_URL: `http://127.0.0.1:${JIRA_PORT}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let out = ""; server.stdout.on("data", (d) => (out += d)); server.stderr.on("data", (d) => (out += d));
const call = async (method: string, p: string, body?: unknown, token = ROOT) => {
  const r = await fetch(B + p, { method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  let json: any = null; try { json = await r.json(); } catch { /* not JSON */ }
  return { status: r.status, body: json };
};
const upload = async (projectId: string, filename: string, bytes: Buffer, token = ROOT) => {
  const r = await fetch(`${B}/projects/${projectId}/documents`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Filename": encodeURIComponent(filename), "Content-Type": "application/octet-stream" }, body: new Uint8Array(bytes) });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const settle = async (id: string) => {
  for (let i = 0; i < 80; i++) { const d = (await call("GET", `/documents/${id}`)).body; if (d.status === "ready" || d.status === "failed") return d; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("the document never settled");
};

try {
  for (let i = 0; i < 60; i++) { try { if ((await fetch(B + "/health")).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 250)); }
  const prj = (await call("GET", "/projects")).body[0];

  console.log("uploading");
  ok((await upload(prj.id, "setup.exe", Buffer.from("MZ"))).status === 400, "anything but PDF / Word / text is refused");
  let s = await upload(prj.id, "Acme AMC 2026.pdf", pdfWith(AMC));
  ok(s.status === 202 && s.body.status === "reading", "a PDF is taken and read in the background");
  let d = await settle(s.body.id);
  ok(d.status === "ready", `the PDF is analysed (${d.error ?? "ok"})`);
  ok(d.text.includes("Annual Maintenance Contract") && d.text.includes("4 hours"), "the text comes out of the real PDF");
  ok(modelCalls === 2, "a reply without the asked-for JSON is asked for again, once");
  ok(d.tasks.length === 3 && d.tasks[0].id === "t1" && d.tasks[0].kind === "site" && d.analysis.contract.client === "Acme Ltd", "the contract becomes a checked task list with the contract's facts");
  ok((await call("GET", "/models/usage")).body.totals.total >= 2400, "the analysis is counted in model usage");

  s = await upload(prj.id, "Acme AMC.docx", await docxWith(AMC));
  const word = await settle(s.body.id);
  ok(word.status === "ready" && word.text.includes("monthly uptime report"), "the text comes out of a real Word file");
  ok((await call("GET", `/projects/${prj.id}/documents`)).body.documents.length === 2, "the project lists its documents");

  console.log("tickets");
  ok((await call("POST", `/documents/${d.id}/tickets`, { taskIds: ["t2"] })).status === 400, "no tickets while the project has no Jira project");
  await call("PUT", "/auth/jira", { siteUrl: `http://127.0.0.1:${JIRA_PORT}`, email: EMAIL, token: TOKEN });
  await call("PATCH", `/projects/${prj.id}`, { jira: { projectKey: "ACME" } });
  ok(filed.length === 0, "nothing was filed by reading the document");
  s = await call("POST", `/documents/${d.id}/tickets`, { taskIds: ["t2", "t3"] });
  ok(s.status === 200 && s.body.created.length === 2 && filed[0].project.key === "ACME" && filed[0].summary === "Send the monthly uptime report", "one ticket per chosen task, in ACME");
  ok(filed[0].labels.includes("monthly") && JSON.stringify(filed[0].description).includes("monthly uptime report"), "the ticket carries the frequency and the contract's words");
  s = await call("POST", `/documents/${d.id}/tickets`, { taskIds: ["t2"] });
  ok(s.body.created.length === 0 && filed.length === 2, "a task that has a ticket is not filed twice");

  console.log("sessions");
  s = await call("POST", `/documents/${d.id}/tasks/t1/session`);
  ok(s.status === 201 && s.body.jobId, "a site task starts a session");
  const job = (await call("GET", `/jobs/${s.body.jobId}`)).body;
  ok(job.projectId === prj.id && job.prompt.includes("Update plugins and WordPress core") && job.prompt.includes("Not covered by the contract"), "the session is in the project, with the task and the contract's limits");
  ok((await call("POST", `/documents/${d.id}/tasks/t1/session`)).status === 409, "a task's session is not started twice");
  s = await call("PATCH", `/documents/${d.id}/tasks/t3`, { dismissed: true });
  ok(s.body.tasks.find((t: any) => t.id === "t3").dismissed === true, "a task can be set aside");

  console.log("a client");
  const owner = (await call("POST", "/auth/setup", { email: "o@example.com", password: "owner password 1", rootToken: ROOT }, "")).body.token;
  await call("POST", "/admin/accounts", { email: "c@example.com", password: "client password 1", role: "client", siteIds: ["site_one"] }, owner);
  const client = (await call("POST", "/auth/login", { email: "c@example.com", password: "client password 1" }, "")).body.token;
  ok((await call("GET", `/projects/${prj.id}/documents`, undefined, client)).status === 403, "a client cannot list documents");
  ok((await upload(prj.id, "x.txt", Buffer.from("x".repeat(100)), client)).status === 403, "or upload one");

  console.log("cleaning up");
  ok((await call("DELETE", `/documents/${word.id}`)).status === 200 && (await call("GET", `/documents/${word.id}`)).status === 404, "a document is deleted");
} finally {
  server.kill(); model.close(); jira.close();
  fs.rmSync(data, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) FAILED\n--- server output ---\n${out.slice(-3000)}`); process.exit(1); }
console.log("\nall document checks passed");
