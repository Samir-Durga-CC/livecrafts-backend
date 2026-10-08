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

## Run it
Needs **Node 22+**, a model key (or any AI SDK provider), and on each site the Livecrafts plugin **0.10+** with an
administrator's **Application Password**.

```bash
npm install
npm run build:web           # the chat UI (web/dist)
cp .env.example .env        # model key(s), LC_MODEL, LC_API_TOKEN for anything not on localhost
npm test                    # fake site + scripted model, plus the checker in a real browser if Edge/Chrome is installed
npm start                   # http://127.0.0.1:8790
npm run demo                # the UI with a FAKE site and a FAKE model: http://127.0.0.1:8791
```

Connect a site (app → Sites, or `POST /sites`). The backend checks the credentials and fetches the site's widget
secret (`POST /livecrafts/v1/connect`), which it uses to verify the per-person tokens the widget sends.

## Settings (.env)
| Name | |
|---|---|
| `LC_MODEL` | Default model, e.g. `gpt-5.5`, `anthropic:claude-sonnet-5-5`, `openrouter:google/gemini-3-pro` |
| `LC_API_TOKEN` | Required `Authorization: Bearer …` for the app/admin routes. The widget uses its own signed per-person token. |
| `LC_VERIFY_CHANGES` | `0` turns the browser checks off (e.g. a server without Edge/Chrome). Default on. |
| `LC_ALLOW_THEME_FILES` | `1` lets the assistant edit theme files. They go **live at once** (cannot be drafts) - off by default. |
| `LC_BROWSER_PATH` | Edge/Chrome path if neither is found automatically. |
| `LC_TTS_VOICE` | Default voice of the voice mode (`onyx`, `ash`, `echo`, `fable`, `sage`, `alloy`, `coral`, `nova`, `shimmer`, `ballad`, `verse`). Each person can pick another in the widget. Default `onyx`. |
| `LC_TTS_MODEL` / `LC_STT_MODEL` | Speech and transcription models. Default `gpt-4o-mini-tts` / `gpt-4o-mini-transcribe`. Voice uses the OpenAI key. |

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
