import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { CliJob, CliStatus, Run, RunOpts } from "./claudeCli.js";
import { secrets } from "./secrets.js";

/**
 * "Your computer": the person's own machine answers for the Claude CLI provider.
 *
 * WHY: a hosted backend has no Claude CLI and no subscription login, so it could only run on paid API keys. The
 * connector (tools/connector.mjs, served at /connector.mjs) runs on the person's computer, where the CLI is installed
 * and signed in, and keeps ONE outbound WebSocket open to this backend - no port to open, no tunnel.
 *
 * HOW: the connector signs in with its token in the first message. Each agent step is sent as a job - model, system
 * prompt, transcript - and the connector builds the command line itself (the same flags as jobArgs), so this backend
 * can never make someone's computer run anything but `claude --print` with its tools switched off. The CLI's stdout
 * comes back in chunks and is read exactly like a local run's.
 *
 * One connector at a time: a new one replaces the old (the person restarted it, or moved to another computer).
 */

/** What the connector reports about the computer it runs on. */
export interface ConnectorHello {
  machine: string;
  platform: string;
  version: string;
  agents: { claude?: { installed: boolean; version?: string; loggedIn: boolean; authMethod?: string; error?: string; fix?: string } };
}

interface Pending {
  stdout: string; stderr: string;
  reader?: ReturnType<typeof lineReader>;
  resolve: (r: Run) => void; reject: (e: Error) => void;
  timer: NodeJS.Timeout; abortSignal?: AbortSignal; onAbort?: () => void;
}

const hash = (t: string) => crypto.createHash("sha256").update(t).digest();
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/** NDJSON lines out of chunks that can split a line anywhere - the connector's output arrives over the network. */
function lineReader(onEvent: (ev: any) => void) {
  let buf = "";
  return {
    push(d: string) {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { onEvent(JSON.parse(line)); } catch { /* a log line, not JSON */ }
      }
    },
    end() { if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { /* a partial last line */ } } buf = ""; },
  };
}

/** Only what the UI shows is kept from the hello, and every field is cut to size: it comes from outside. */
function cleanHello(h: any): ConnectorHello {
  const c = h?.agents?.claude;
  return {
    machine: str(h?.machine, 80) ?? "unknown computer",
    platform: str(h?.platform, 20) ?? "",
    version: str(h?.version, 20) ?? "",
    agents: {
      claude: c ? {
        installed: !!c.installed, loggedIn: !!c.loggedIn, version: str(c.version, 60), authMethod: str(c.authMethod, 40),
        error: str(c.error, 300), fix: str(c.fix, 300),
      } : undefined,
    },
  };
}

class Connector {
  private wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  private ws: WebSocket | null = null;
  private hello: ConnectorHello | null = null;
  private since = 0;
  private pending = new Map<string, Pending>();
  private ping: NodeJS.Timeout | null = null;

  /** Called by the server for an upgrade to /connector. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
  }

  private accept(ws: WebSocket) {
    const say = (o: Record<string, unknown>) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(o)); };
    const late = setTimeout(() => ws.close(4001, "no sign-in"), 10_000);
    ws.once("message", (raw) => {
      clearTimeout(late);
      let m: any;
      try { m = JSON.parse(String(raw)); } catch { return ws.close(4002, "bad message"); }
      if (m?.type !== "hello" || !this.tokenMatches(String(m.token ?? ""))) {
        say({ type: "rejected", reason: "This connector token is not valid any more. Make a new one in Livecrafts: Integrations → AI models → Your computer." });
        return ws.close(4003, "wrong token");
      }
      if (this.ws && this.ws !== ws) this.ws.close(4000, "Replaced by a newer connection.");
      this.ws = ws;
      this.hello = cleanHello(m.hello);
      this.since = Date.now();
      say({ type: "welcome" });
      console.log(`Connector: ${this.hello.machine} connected (Claude CLI ${this.hello.agents.claude?.version ?? "not found"}).`);
      // Proxies drop a connection that says nothing for a minute or two.
      if (this.ping) clearInterval(this.ping);
      this.ping = setInterval(() => { if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping(); }, 25_000);
      ws.on("message", (data) => this.onMessage(data));
      ws.on("close", () => {
        if (this.ws !== ws) return;
        console.log(`Connector: ${this.hello?.machine ?? "computer"} disconnected.`);
        this.ws = null; this.hello = null;
        if (this.ping) { clearInterval(this.ping); this.ping = null; }
        for (const [id, p] of this.pending) this.settle(id, p, () => p.reject(new Error("Your computer disconnected from Livecrafts in the middle of this step. Start the connector again and retry.")));
      });
    });
    ws.on("error", () => { /* a close follows */ });
  }

  private tokenMatches(given: string) {
    const want = secrets.connectorTokenHash();
    if (!want || !given) return false;
    const a = hash(given), b = Buffer.from(want, "hex");
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private onMessage(data: RawData) {
    let m: any;
    try { m = JSON.parse(String(data)); } catch { return; }
    if (m?.type === "status") { this.hello = cleanHello(m.hello); return; }
    const p = this.pending.get(String(m?.id ?? ""));
    if (!p) return;
    if (m.type === "out" && typeof m.data === "string") { if (p.reader) p.reader.push(m.data); else p.stdout += m.data; }
    else if (m.type === "err" && typeof m.data === "string") p.stderr = (p.stderr + m.data).slice(0, 4000);
    else if (m.type === "exit") this.settle(m.id, p, () => { p.reader?.end(); p.resolve({ stdout: p.stdout, stderr: p.stderr || str(m.error, 1000) || "", code: typeof m.code === "number" ? m.code : null }); });
  }

  private settle(id: string, p: Pending, fn: () => void) {
    if (!this.pending.delete(id)) return;
    clearTimeout(p.timer);
    if (p.onAbort) p.abortSignal?.removeEventListener("abort", p.onAbort);
    fn();
  }

  /** Is a computer connected right now? The Claude CLI provider then runs there instead of on this machine. */
  connected() { return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.hello; }

  /** One step on the person's computer - the same contract as running the CLI here. */
  run(job: CliJob, o: RunOpts, onEvent?: (ev: any) => void): Promise<Run> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Your computer is not connected to Livecrafts."));
    if (o.abortSignal?.aborted) return Promise.reject(new Error("aborted"));
    const id = "run_" + crypto.randomBytes(8).toString("hex");
    return new Promise<Run>((resolve, reject) => {
      const p: Pending = {
        stdout: "", stderr: "", resolve, reject, abortSignal: o.abortSignal,
        reader: onEvent ? lineReader(onEvent) : undefined,
        timer: setTimeout(() => {
          ws.send(JSON.stringify({ type: "cancel", id }));
          this.settle(id, p, () => reject(new Error(`The Claude CLI on your computer did not answer within ${Math.round(o.timeoutMs / 1000)}s.`)));
        }, o.timeoutMs),
      };
      p.onAbort = () => { ws.send(JSON.stringify({ type: "cancel", id })); this.settle(id, p, () => reject(new Error("aborted"))); };
      o.abortSignal?.addEventListener("abort", p.onAbort, { once: true });
      this.pending.set(id, p);
      ws.send(JSON.stringify({
        type: "run", id, agent: "claude", timeoutMs: o.timeoutMs,
        job: { model: job.model, system: job.system, stdin: job.stdin, stream: job.stream, effort: job.effort ?? "" },
      }));
    });
  }

  /** The Claude CLI's status as the connected computer reported it, or null when no computer is connected. */
  cliStatus(): CliStatus | null {
    if (!this.connected()) return null;
    const c = this.hello!.agents.claude;
    const ready = !!c?.installed && !!c?.loggedIn;
    return {
      installed: !!c?.installed, version: c?.version, loggedIn: !!c?.loggedIn, authMethod: c?.authMethod, ready,
      bin: `your computer (${this.hello!.machine})`,
      ...(ready ? {} : {
        error: c?.error ?? (c?.installed ? "The Claude CLI on your computer is not signed in." : "The Claude CLI is not installed on your computer."),
        fix: c?.fix ?? (c?.installed ? 'Run "claude auth login" on your computer, then restart the connector.' : "Install Claude Code (claude.com/claude-code) on your computer, then restart the connector."),
      }),
    };
  }

  /** For the Integrations screen. */
  info() {
    return {
      hasToken: !!secrets.connectorTokenHash(),
      connected: this.connected(),
      since: this.connected() ? new Date(this.since).toISOString() : undefined,
      machine: this.hello?.machine, platform: this.hello?.platform, version: this.hello?.version,
      claude: this.hello?.agents.claude,
      running: this.pending.size,
    };
  }

  /** A new token: shown once, only its hash is kept. Whoever was connected with the old one is dropped. */
  newToken(): string {
    const token = "lcc_" + crypto.randomBytes(24).toString("hex");
    secrets.setConnectorTokenHash(hash(token).toString("hex"));
    this.ws?.close(4003, "The connector token was replaced.");
    return token;
  }

  revoke() {
    secrets.setConnectorTokenHash("");
    this.ws?.close(4003, "The connector token was revoked.");
  }
}

export const connector = new Connector();
