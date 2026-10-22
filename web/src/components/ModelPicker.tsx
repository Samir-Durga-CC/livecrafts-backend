import { useEffect, useRef, useState } from "react";
import { FloatingMenu } from "./FloatingMenu";
import { api } from "../api";
import { Icon } from "../icons";
import type { ModelChoice, ModelsReport } from "../types";

/**
 * Which brain answers: an API model (OpenAI, Anthropic …) or the Claude CLI on the backend machine, which runs on its
 * own Claude subscription and needs no API credit. "" means: whatever the backend / WordPress already decided.
 * The backend lists only the ones that can answer right now (GET /models), and says why the others cannot.
 */
export function shortLabel(id: string, fallback = "model"): string {
  if (!id) return fallback;
  const [provider, ...rest] = id.split(":");
  const model = rest.join(":") || provider;
  return provider === "claudecli" ? `Claude CLI · ${model}` : model;
}

let cache: ModelsReport | null = null;

export function ModelPicker({ value, onChange, fallback }: {
  value: string;
  onChange: (id: string) => void;
  /** What answers when nothing is picked (the backend default, or the site's own model from WordPress). */
  fallback?: string;
  /** Kept for callers; the menu now decides for itself which way it has room to open. */
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const [report, setReport] = useState<ModelsReport | null>(cache);

  useEffect(() => {
    if (cache) return;
    api.models().then((r) => { cache = r; setReport(r); }).catch(() => {});
  }, []);

  const choices = report?.choices ?? [];
  const missing = (report?.providers ?? []).filter((p) => !p.configured);
  const byProvider = choices.reduce<Record<string, ModelChoice[]>>((acc, c) => { (acc[c.providerName] ??= []).push(c); return acc; }, {});
  const usingCli = value.startsWith("claudecli:");

  const pick = (id: string) => { onChange(id); setOpen(false); };

  return (
    <div className="mode-pick">
      <button ref={btn} className={`model-pill${usingCli ? " model-cli" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open}
        title={value ? `Answering: ${value}` : `Answering: ${fallback ?? "the backend default"} (not chosen here)`}>
        <Icon.Sparkle size={13} /> {shortLabel(value, shortLabel(fallback ?? "", "model"))} <Icon.ChevronDown size={12} />
      </button>
      {/* Opened through a portal: the composer's button row scrolls sideways, and an overflow ancestor clips
          anything positioned inside it - which is why this menu used to appear as a sliver behind the buttons. */}
      <FloatingMenu anchor={btn} open={open} onClose={() => setOpen(false)}>
          <div>
            <div className="menu-label">Which model answers</div>
            <button className="menu-item mode-item" onClick={() => pick("")}>
              <span className="grow"><b>Default</b><small>{fallback ? shortLabel(fallback) : "set by the backend or in WordPress"}</small></span>
              {!value && <Icon.Check size={15} />}
            </button>
            {Object.entries(byProvider).map(([name, list]) => (
              <div key={name}>
                <div className="menu-label">{name}</div>
                {list.map((c) => (
                  <button key={c.id} className="menu-item mode-item" onClick={() => pick(c.id)}>
                    <span className="grow"><b>{c.model}</b>{c.provider === "claudecli" && <small>runs on this machine's Claude subscription - no API credit</small>}</span>
                    {value === c.id && <Icon.Check size={15} />}
                  </button>
                ))}
              </div>
            ))}
            {missing.length > 0 && (
              <>
                <div className="menu-label">Not ready</div>
                {missing.map((p) => (
                  <div key={p.id} className="menu-note">
                    <b>{p.name}</b>
                    <small>{p.id === "claudecli" ? (p.cli?.error ?? 'run "claude auth login" on the backend machine') : "no API key yet - add it in Integrations"}</small>
                  </div>
                ))}
              </>
            )}
            {!report && <div className="menu-note"><small>Loading the list…</small></div>}
          </div>
      </FloatingMenu>
    </div>
  );
}
