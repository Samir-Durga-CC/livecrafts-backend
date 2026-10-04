# Livecrafts backend

Central agent service. The browser (or a WordPress plugin widget) only *watches*; the work runs here.

```
UI / plugin widget ──HTTP+SSE──►  this backend  ──REST (Application Password)──►  WordPress site (Livecrafts plugin >= 0.6)
                                  ├─ AI SDK 7 ToolLoopAgent   (loop, tool calling, retries, step limit, approvals)
                                  ├─ Jobs: saved after every run → pause for approval, resume after restart
                                  └─ Tools: get_page_map · read_target · find_text · set_content* · verify_page ·
                                            upload_media_from_chat* · undo_last_change* · list_pages     (* = needs approval)
```

## Requirements
* **Node 22 or newer** (AI SDK 7 requires it). `node -v` — if it says 20.x, install Node 22 LTS.
* An OpenAI API key (or any model reachable through the AI SDK / AI Gateway).
* On each WordPress site: Livecrafts plugin **0.6+** and an **Application Password** (Users → Profile → Application Passwords). WordPress needs HTTPS for these.

## Chat UI (`web/`)
A React single-page app (Vite + TypeScript, no UI framework) built to `web/dist` and served by this backend at `/`.
Features: **streaming answers** (word by word, with a typing caret), user messages in an outlined bubble and answers as clean
Markdown text (bold, lists, tables, code blocks with Copy), a one-line activity summary per run, **approval cards with a
Before → After comparison and Approve / Deny**, a Changes panel, follow-up messages in the same conversation, **image attach
(button, drag & drop, paste)**, pinned/dated history, light/dark theme, phone layout, and reconnect-safe progress (reload and the
whole chat comes back; text still streaming at that moment arrives as one finished message).
It can receive context from a link: `/?site=<id>&page=<url>&target=<target id>` (this is what the WordPress plugin button will use).

## Run it
```bash
cd livecrafts-backend
npm install
npm run build:web           # builds the chat UI into web/dist (needed once, and after UI changes)
cp .env.example .env        # put OPENAI_API_KEY in it; change LC_MODEL to switch models
npm test                    # 27 checks, no API key and no real site needed
npm start                   # open http://127.0.0.1:8790
npm run demo                # try the UI with a FAKE site and a FAKE model: http://127.0.0.1:8791
```

### Quick terminal test (no server)
```bash
export LC_SITE_URL=https://your-site.com   LC_SITE_USER=admin   LC_SITE_APP_PASSWORD="abcd efgh ijkl ..."
npm run chat -- "change the hero title to Welcome to Aeromatic"
```
It prints each tool call, shows an **Allow? [y/N]** prompt for every change, then verifies the public page.

## HTTP API (all JSON; set `LC_API_TOKEN` to require `Authorization: Bearer …`)
| Call | Purpose |
|---|---|
| `POST /sites` `{name,url,username,appPassword}` | Register a site. Pings it first (validates the credentials); the password is never returned. |
| `GET /sites` · `DELETE /sites/:id` · `POST /sites/:id/ping` | Manage / check sites |
| `POST /files` (raw body, `Content-Type: image/png`, `x-filename`) | Attach an image from the user's computer → `fileId` |
| `POST /jobs` `{siteId,prompt,pageUrl?,selectedTarget?,fileIds?}` | Start a job (returns immediately) |
| `GET /jobs/:id` · `GET /jobs` | State + events |
| `GET /jobs/:id/events?after=<seq>` | **Server-Sent Events**; reconnect-safe replay |
| `POST /jobs/:id/approvals` `{approvalId,approved,reason?}` | Answer an approval card |
| `POST /jobs/:id/resume` | Continue an interrupted/failed job |

## What happens if the browser closes
Nothing is lost. A job is saved to disk after every run. When the agent needs permission the job goes to `waiting_approval`
and costs nothing while it waits; answering later (even after a restart) continues from the saved conversation.

## Files
| File | Job |
|---|---|
| `src/agent.ts` | Builds the SDK `ToolLoopAgent`: model, system prompt, tools, approval policy, step limit, retries. Model-neutral. |
| `src/tools.ts` | The tools (small, typed, zod schemas). Expected failures return `{ok:false,error}` so the model can react. |
| `src/bridge.ts` | Talks to the WordPress plugin: Basic auth, timeouts, retries (reads only), clear error hints, same-origin guard. |
| `src/jobs.ts` | Job runner: persist, pause/resume on approvals, event stream, crash recovery. |
| `src/server.ts` / `src/cli.ts` | HTTP API / terminal chat |
| `src/store.ts` / `src/files.ts` | JSON-file storage (dev) / chat image uploads |
| `test/smoke.ts` | End-to-end test with a fake WordPress and a scripted mock model |

## Known limits (v0.1)
* Storage is JSON files and the site password sits in `data/sites/*.json` — **dev only**; move to Postgres + encrypted secrets before real use.
* No user login yet (binds to localhost; optional bearer token). MFA and per-user permissions come later.
* The loop is in-process: a server crash mid-step loses that step (the job is marked `interrupted` and can be resumed). True durable execution = AI SDK `WorkflowAgent` (needs the Workflow runtime) — a later upgrade.
* verify_page checks the public HTML text; a headless browser (screenshots, computed styles) and the URL-scraper tool are not built yet.
* The model has only been exercised through a scripted mock — **no real LLM run yet**.
