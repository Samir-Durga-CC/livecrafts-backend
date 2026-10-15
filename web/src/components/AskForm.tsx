import { useMemo, useState } from "react";
import { Icon } from "../icons";

/**
 * The questions the assistant still needs answered, as ONE small form.
 *
 * It exists so the assistant stops asking question after question in prose: it calls ask_person once with everything
 * it needs, the person fills this in, and the answers go back as a single message. Design decisions never appear here
 * - the assistant takes those from the site itself.
 */
export interface AskQuestion { key: string; question: string; options?: string[]; placeholder?: string; optional?: boolean }

export function AskForm({ intro, questions, busy, onSend }: {
  intro?: string;
  questions: AskQuestion[];
  busy: boolean;
  onSend: (text: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const set = (k: string, v: string) => setAnswers((a) => ({ ...a, [k]: v }));

  const missing = useMemo(
    () => questions.filter((q) => !q.optional && !(answers[q.key] ?? "").trim()).length,
    [questions, answers],
  );

  const send = (skip = false) => {
    const lines = questions
      .map((q) => ({ q, a: (answers[q.key] ?? "").trim() }))
      .filter((x) => x.a || !skip)
      .map(({ q, a }) => `${q.question} — ${a || "(you decide)"}`);
    onSend(lines.join("\n"));
  };

  return (
    <div className="ask-card">
      <div className="ask-head"><Icon.Sparkle size={14} /> <b>A few things to confirm</b></div>
      {intro && <p className="ask-intro">{intro}</p>}
      <div className="ask-list">
        {questions.map((q) => (
          <label key={q.key} className="ask-q">
            <span className="ask-label">{q.question}{q.optional && <em> (optional)</em>}</span>
            {q.options?.length ? (
              <div className="ask-options" role="group">
                {q.options.map((o) => (
                  <button key={o} type="button" className={(answers[q.key] ?? "") === o ? "on" : ""}
                    onClick={() => set(q.key, o)}>{o}</button>
                ))}
              </div>
            ) : (
              <input
                value={answers[q.key] ?? ""}
                placeholder={q.placeholder ?? ""}
                onChange={(e) => set(q.key, e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !missing) { e.preventDefault(); send(); } }}
              />
            )}
          </label>
        ))}
      </div>
      <div className="ask-actions">
        <button className="btn ghost" disabled={busy} onClick={() => send(true)} title="Send what you have; the assistant decides the rest">
          You decide
        </button>
        <button className="btn primary" disabled={busy} onClick={() => send()}>
          <Icon.Check size={15} /> Send {missing > 0 ? `(${questions.length - missing}/${questions.length})` : ""}
        </button>
      </div>
    </div>
  );
}
