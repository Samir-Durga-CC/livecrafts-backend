# Livecrafts backend

The agent service behind the Livecrafts WordPress plugin. The browser (the plugin's chat widget, or this app) only
*watches*; the work runs here.

```
WordPress page ── widget.js ──(cookie + nonce)──► Livecrafts plugin  ◄──(Application Password + person's token)── this backend
   └─ chat panel (iframe of this app) ──HTTP+SSE, X-Livecrafts-Widget──────────────────────────────────────────────► │
                                                                                       ├─ AI SDK ToolLoopAgent (tools, approvals, step limit)
                                                                                       ├─ Jobs: saved after every run, pause/resume
                                                                                       ├─ verify.ts: every change checked in a real browser
                                                                                       └─ usage.ts: every model call + tokens, app log
```

## Setup (from zero)

Livecrafts has two parts. This repo is the **backend** (the agent + chat app). The WordPress side is the
**livecrafts-plugin** repo - set that up too (its README has the steps). You need both.

### 1. What you need
| | |
|---|---|
| **Node.js 22 or newer** | `node --version` must print v22+. Get it from https://nodejs.org |
| **Git** | to clone the repo |
| **A model API key** | OpenAI by default. Anthropic, OpenRouter, Groq or any OpenAI-compatible server also work. |
| **Microsoft Edge or Google Chrome** | used for the automatic page checks (already installed on most computers). Optional: set `LC_VERIFY_CHANGES=0` to skip. |
| **A WordPress site** with the Livecrafts plugin 0.10+ | WordPress 6.2+, PHP 7.4+. |

### 2. Install
```bash
git clone <this repo's URL> livecrafts-backend
cd livecrafts-backend
npm install            # backend dependencies
npm run build:web      # installs + builds the chat UI into web/dist (needed once, and after any change in web/)
```

### 3. Create your `.env`
```bash
cp .env.example .env          # Windows PowerShell: Copy-Item .env.example .env
```
Open `.env` and fill in at least **one model key** (see "Settings" below). Minimum working file:
```ini
LC_MODEL=gpt-5.5
OPENAI_API_KEY=sk-...
```
* `.env` holds secrets and is git-ignored - **never commit it or send it to anyone**. Share `.env.example` instead.
* Model keys can alternatively be added later inside the app (Integrations -> AI models). A key in `.env` always wins.
* Running on a server or anywhere other than your own computer? Also set `LC_API_TOKEN` (a long random string) so
  strangers cannot call the app: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

### 4. Start it
```bash
npm start              # http://127.0.0.1:8790   (npm run dev restarts on code changes)
```
Open http://127.0.0.1:8790 in a browser. Restart `npm start` after changing `.env` or anything in `src/`.

### 5. Connect your WordPress site
1. In WordPress install and activate the **Livecrafts plugin** (see its README).
2. In wp-admin: **Users -> Profile -> Application Passwords**, type a name (e.g. `livecrafts`), click *Add New*, and copy the
   password (shown once). It must be an **administrator** account. (Application Passwords need HTTPS on a live site;
   on a local site they work over http.)
3. In the app, open the site picker in the sidebar and choose **Connect a site**: a name, the site URL, the WordPress username and that Application Password.
   (Same thing via the API: `POST /sites`.) The backend checks them and fetches the site's widget secret
   (`POST /livecrafts/v1/connect`).
4. In WordPress: **Settings -> Livecrafts Assistant**, set *Livecrafts backend address* to where this app runs
   (`http://127.0.0.1:8790` on your own computer, or its public https address on a server).
5. Log in to the site as an editor: the Livecrafts chat button appears on every page.

### 6. Check that it works
```bash
npm test               # fake site + scripted model; includes the browser checks if Edge/Chrome is installed
npm run typecheck      # TypeScript, backend and web
npm run demo           # the UI with a FAKE site and FAKE model (no keys needed): http://127.0.0.1:8791
```
`npm run demo` is the quickest way to look at the product without any key or WordPress site.

### Troubleshooting
| Problem | Fix |
|---|---|
| `node: bad option: --env-file-if-exists` | Node is older than 22 - upgrade. |
| Blank page at http://127.0.0.1:8790 | `npm run build:web` was not run (no `web/dist`). |
| "No browser available for page checks" | Install Edge/Chrome, set `LC_BROWSER_PATH`, or set `LC_VERIFY_CHANGES=0`. |
| Model errors / 401 | Wrong or missing key for the provider in `LC_MODEL` (`openai:` -> `OPENAI_API_KEY`, `anthropic:` -> `ANTHROPIC_API_KEY`, ...). |
| Site connect fails | Wrong Application Password, user is not an administrator, plugin not active, or the site URL is wrong (include `https://`). |
| Chat button does not open the chat | The *backend address* in Settings -> Livecrafts does not match where the app runs. |
| Port 8790 busy | Set `PORT=` in `.env` and update the backend address in WordPress. |

Your data (chats, connected sites and their secrets, usage logs) lives in `data/` (override with `LC_DATA_DIR`). It is
git-ignored; back it up if it matters and do not share it.

## How a change happens
1. The assistant (or the person, in the widget's click panel) makes a change. It is a **draft**: the plugin stores it
   in the real source (Elementor, blocks, ACF, post fields, Additional CSS), and logged-in editors see it on the site.
   Visitors see the live site until a person **deploys** (password, in the widget). The backend cannot deploy.
2. After each change the backend **checks it in a real browser** (`verify.ts`): the draft view through a 10-minute
   view-only preview token (the change is there: text, element, computed styles vs. the intended values), page health
   on desktop and mobile (loads, PHP errors, sideways scrolling, broken images, script errors), visitors do not see it
   yet, and what else moved (text diff, screenshot diff by page area). The model gets the result with the tool
   result and must fix or revert a failure.
3. Every change is in the site's **history** (plugin), from every source - the assistant, the widget, WP admin, the
   Elementor editor - with who/when/before/after. Each run starts with that context: drafts, conflicts, outside changes
   since the last release, and the assistant's **notes** about the site and the page.

## Settings (.env)
Copy `.env.example` to `.env`. Everything is optional except one model key.

| Name | |
|---|---|
| `LC_MODEL` | Default model, e.g. `gpt-5.5`, `anthropic:claude-sonnet-5-5`, `openrouter:google/gemini-3-pro`, `groq:openai/gpt-oss-120b`, `custom:<name>`. A plain id uses OpenAI. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` / `GROQ_API_KEY` | Key for the provider you chose. Only the one you use is needed. `OPENAI_API_KEY` is also used by voice mode. |
| `LC_CUSTOM_BASE_URL` / `LC_CUSTOM_API_KEY` | Any OpenAI-compatible server (LM Studio, vLLM, Together ...), used with `LC_MODEL=custom:<name>`. |
| `PORT` / `HOST` | Where the app listens. Default `8790` / `127.0.0.1` (own computer only). |
| `LC_API_TOKEN` | Required `Authorization: Bearer ...` for the app/admin routes. **Set it for anything not on localhost.** The widget uses its own signed per-person token. |
| `LC_DATA_DIR` | Where chats, sites, usage and logs are stored. Default `./data`. |
| `LC_MAX_STEPS` | Max tool steps per assistant run. Default 30. |
| `LC_JOB_TIMEOUT_MS` / `LC_BRIDGE_TIMEOUT_MS` | Run timeout (default 5 min) / WordPress request timeout (default 30 s). |
| `HOSTINGER_API_TOKEN` | Optional: hosting info + theme-file access via Hostinger. Can also be pasted in the app (Integrations). |
| `LC_VERIFY_CHANGES` | `0` turns the browser checks off (e.g. a server without Edge/Chrome). Default on. |
| `LC_ALLOW_THEME_FILES` | `1` lets the assistant edit theme files. They go **live at once** (cannot be drafts) - off by default. Every edit is still recorded in the site's change ledger (see below). |
| `LC_BROWSER_PATH` | Edge/Chrome path if neither is found automatically. |
| `LC_SKILLS_DIR` | Folder with extra assistant skills. Default `./skills`. |
| `LC_TTS_VOICE` | Default voice of the voice mode (`onyx`, `ash`, `echo`, `fable`, `sage`, `alloy`, `coral`, `nova`, `shimmer`, `ballad`, `verse`). Each person can pick another in the widget. Default `onyx`. |
| `LC_TTS_MODEL` / `LC_STT_MODEL` | Speech and transcription models. Default `gpt-4o-mini-tts` / `gpt-4o-mini-transcribe`. Voice uses the OpenAI key. |

## One record of every change

The **site's change ledger** (in WordPress, written by the plugin) is the only record: drafts, live changes, resets, edits made
in wp-admin / Elementor, and - since plugin 0.13 - theme-file edits (full before/after). A chat only keeps a pointer to each
change it made (`pluginId`) and re-reads their state from the ledger whenever it is opened, so a change reverted in the page
widget, in wp-admin or in another chat shows as reverted here too. Reverting works from any of them (`POST /changes/<id>/revert`);
"Discard all" also puts back theme files edited since the last release, Deploy accepts them into the release, and a reset to a
release restores files edited after it. `data/backups/` is only a fallback for the hosting-account route (an old plugin).

## Voice mode (widget)
The mic button in the chat turns on hands-free voice: the microphone stays open, a pause ends what you said (no Enter),
it is transcribed (`POST /voice/transcribe`) and sent as a normal chat message; answers are read aloud sentence by
sentence (`POST /voice/speak`). Everything stays visible in the chat. Say "yes" / "no" to approvals, "stop" to
interrupt work, "stop talking" to cut the answer short, "goodbye" to end. Talking over an answer interrupts it. After a
change the page reloads once the answer was spoken, and voice mode resumes. Needs plugin 0.11+ (it lets the chat frame
use the microphone). Without an OpenAI key the browser's own speech recognition and voices are used where available.

## Who may call what
| Caller | Auth | Can |
|---|---|---|
| App / admin panel | `LC_API_TOKEN` (or localhost without one) | everything |
| Chat in the WordPress widget | `X-Livecrafts-Widget: <token>` signed by the site for the logged-in person | its own site only: chats, approvals, files, the person's-browser line |

## Files
| File | Job |
|---|---|
| `src/agent.ts` | The `ToolLoopAgent`: model, system prompt (drafts, native sources, checks, notes), approvals, browser views. |
| `src/tools.ts` | Tools: site_status / site_history / change_details, notes, page map, read_post, make_change, create_page, revert_change, media, browser, theme files (read; writes only when allowed). |
| `src/verify.ts` | The automatic checks after each change. |
| `src/browser.ts` | Headless Edge/Chrome: read, inspect (computed styles + winning rules), screenshot, design, page audit, screenshot diff. |
| `src/bridge.ts` | The plugin's REST API (drafts, history, notes, preview tokens) + core REST reads; credits the person. |
| `src/auth.ts` | Widget token verification. |
| `src/jobs.ts` | Job runner: persist, approvals, stop/continue, site context at the start of each run, usage per model call. |
| `src/changes.ts` | A chat's pointers into the site history (revert, diff). |
| `src/usage.ts` | `data/usage/*.jsonl` (model, tokens per call), `data/logs/*.jsonl` (+ live follow). |
| `src/eyes.ts` | The person's own browser (widget open) as the assistant's eyes. |
| `src/voice.ts` | Voice mode: speech to text and text to speech (OpenAI audio API, key stays on the server). |
| `web/` | React UI: the app, and the widget (chat, click panel without AI, site history). |
| `test/` | `fakeSite.ts` (plugin 0.10 API in memory), `smoke.ts`, `features.ts`, `verify-browser.ts`, `demo.ts`. |

## Known limits
* Storage is JSON files (`data/`), and site Application Passwords and secrets sit in `data/` - fine for one server;
  move to a database with encrypted secrets before multi-tenant use.
* The backend's own browser cannot open unpublished (draft) pages; new pages are checked by the person in the
  preview, and after deploy.
