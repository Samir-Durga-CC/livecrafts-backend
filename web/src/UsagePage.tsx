import { useEffect, useState } from "react";
import { api, type ModelUsage, type UsageBucket } from "./api";

/**
 * /usage - what the models cost, in tokens.
 *
 * Read from the same append-only file the agent writes a line to after every step, so nothing here is an estimate:
 * each number is calls that really happened. Cached input is shown apart from fresh input because it is the one
 * number that can be acted on - a high share means the prompts are being reused well, a low one means they are not.
 */
const nf = new Intl.NumberFormat();
const n = (v: number) => nf.format(Math.round(v));
/** Tokens read quickly: 24.8M rather than 24,820,992. The exact figure stays in the title. */
const short = (v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e4 ? `${Math.round(v / 1e3)}k` : n(v));
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const hours = (ms: number) => (ms >= 3.6e6 ? `${(ms / 3.6e6).toFixed(1)} h` : ms >= 6e4 ? `${Math.round(ms / 6e4)} min` : `${Math.round(ms / 1000)} s`);
const monthName = (m: string) => {
  const [y, mo] = m.split("-").map(Number);
  return Number.isFinite(y) && Number.isFinite(mo) ? new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString(undefined, { month: "long", year: "numeric" }) : m;
};
const dayName = (d: string) => new Date(d + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });

function Tile({ label, value, title, foot }: { label: string; value: string; title?: string; foot?: string }) {
  return (
    <div className="us-tile">
      <span className="us-tile-label">{label}</span>
      <strong className="us-tile-value" title={title}>{value}</strong>
      {foot && <span className="us-tile-foot">{foot}</span>}
    </div>
  );
}

/** One row of a "who used what" table, with the bar showing its share of the month. */
function Row({ b, of, name, note }: { b: UsageBucket; of: number; name: string; note?: string }) {
  const share = pct(b.total, of);
  return (
    <tr>
      <th scope="row">
        <span className="us-name">{name}</span>
        {note && <small className="us-note">{note}</small>}
      </th>
      <td className="us-bar-cell">
        <span className="us-bar"><span style={{ width: `${Math.max(share, b.total > 0 ? 1 : 0)}%` }} /></span>
        <span className="us-share">{share}%</span>
      </td>
      <td className="num" title={n(b.total)}>{short(b.total)}</td>
      <td className="num dim" title={`${n(b.input)} fresh + ${n(b.cachedInput)} cached`}>{short(b.input + b.cachedInput)}</td>
      <td className="num dim">{pct(b.cachedInput, b.input + b.cachedInput)}%</td>
      <td className="num dim" title={n(b.output)}>{short(b.output)}</td>
      <td className="num dim">{n(b.calls)}</td>
    </tr>
  );
}

function Table({ title, rows, of, nameOf, noteOf }: {
  title: string; rows: UsageBucket[]; of: number;
  nameOf: (b: UsageBucket) => string; noteOf?: (b: UsageBucket) => string | undefined;
}) {
  if (!rows.length) return null;
  return (
    <section className="us-block">
      <h2>{title}</h2>
      <table className="us-table">
        <thead>
          <tr>
            <th scope="col">{title}</th>
            <th scope="col">Share</th>
            <th scope="col" className="num">Tokens</th>
            <th scope="col" className="num">In</th>
            <th scope="col" className="num" title="How much of the input was served from cache">Cached</th>
            <th scope="col" className="num">Out</th>
            <th scope="col" className="num">Calls</th>
          </tr>
        </thead>
        <tbody>{rows.map((b) => <Row key={b.key} b={b} of={of} name={nameOf(b)} note={noteOf?.(b)} />)}</tbody>
      </table>
    </section>
  );
}

/** Tokens per day: a plain column chart, because the shape is the point and the figures are in the table above. */
function Days({ days }: { days: ModelUsage["byDay"] }) {
  if (!days.length) return null;
  const peak = Math.max(...days.map((d) => d.total), 1);
  return (
    <section className="us-block">
      <h2>Day by day</h2>
      <div className="us-days" role="img" aria-label={`Tokens per day, highest ${n(peak)}`}>
        {days.map((d) => (
          <span key={d.day} className="us-day" title={`${dayName(d.day)}: ${n(d.total)} tokens over ${n(d.calls)} calls`}>
            <span className="us-day-bar" style={{ height: `${Math.max(2, Math.round((d.total / peak) * 100))}%` }} />
            <small>{dayName(d.day).replace(/ \w+$/, "")}</small>
          </span>
        ))}
      </div>
    </section>
  );
}

/**
 * siteId fixes the report to one website and hides the website picker - that is how the widget shows it, where the
 * backend answers with that site's numbers only anyway. compact trims the padding for the widget's dialog.
 */
export default function UsagePage({ siteId, compact }: { siteId?: string; compact?: boolean } = {}) {
  const params = new URLSearchParams(location.search);
  const [month, setMonth] = useState(params.get("month") ?? "");
  const [site, setSite] = useState(siteId ?? params.get("site") ?? "");
  const [data, setData] = useState<ModelUsage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.modelUsage(month || undefined, site || undefined)
      .then((d) => { if (alive) { setData(d); setError(""); } })
      .catch((e) => alive && setError((e as Error).message))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [month, site]);

  const t = data?.totals;
  const inAll = t ? t.input + t.cachedInput : 0;

  return (
    <div className={`us-page${compact ? " compact" : ""}`}>
      <header className="us-head">
        <div>
          <h1>Model usage</h1>
          <p className="muted">{siteId ? "Every call the assistant made for this website, counted from the backend's own record." : "Every call the assistant made, counted from the backend's own record."}</p>
        </div>
        <div className="us-filters">
          <label>
            Month
            <select value={data?.month ?? month} onChange={(e) => setMonth(e.target.value)}>
              {(data?.months ?? []).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}
            </select>
          </label>
          {!siteId && <label>
            Website
            <select value={site} onChange={(e) => setSite(e.target.value)}>
              <option value="">All websites</option>
              {(data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name || s.url}</option>)}
            </select>
          </label>}
        </div>
      </header>

      {error && <div className="banner error">{error}</div>}
      {loading && !data && <p className="muted"><span className="spin" /> Reading the record…</p>}

      {data && t && (
        data.rows === 0 ? (
          <p className="muted">No model calls recorded for {monthName(data.month)}{site ? " on this website" : ""}.</p>
        ) : (
          <>
            <div className="us-tiles">
              <Tile label="Tokens" value={short(t.total)} title={n(t.total)} foot={`${n(t.calls)} calls`} />
              <Tile label="Input" value={short(inAll)} title={n(inAll)} foot={`${pct(t.cachedInput, inAll)}% served from cache`} />
              <Tile label="Output" value={short(t.output)} title={n(t.output)} foot={t.reasoning ? `${short(t.reasoning)} of it reasoning` : "what the models wrote"} />
              <Tile label="Model time" value={hours(t.ms)} foot={t.calls ? `${(t.ms / t.calls / 1000).toFixed(1)}s a call` : undefined} />
            </div>

            <Table title="Provider" rows={data.byProvider} of={t.total} nameOf={(b) => b.key} />
            <Table title="Model" rows={data.byModel} of={t.total} nameOf={(b) => b.key} noteOf={(b) => b.label} />
            <Days days={data.byDay} />
            {!site && <Table title="Website" rows={data.bySite} of={t.total} nameOf={(b) => b.label || b.key} />}

            {data.busiest.length > 0 && (
              <section className="us-block">
                <h2>Most expensive jobs</h2>
                <table className="us-table">
                  <thead><tr><th scope="col">Job</th><th scope="col">Model</th><th scope="col" className="num">Steps</th><th scope="col" className="num">Tokens</th></tr></thead>
                  <tbody>
                    {data.busiest.map((j) => (
                      <tr key={j.job}>
                        <th scope="row"><code>{j.job}</code><small className="us-note">{new Date(j.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small></th>
                        <td>{j.model}</td>
                        <td className="num dim">{j.steps}</td>
                        <td className="num" title={n(j.total)}>{short(j.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            <p className="us-foot muted">
              Tokens only — no prices. Rates differ per model and change, so a figure here would be a guess dressed up as a bill.
            </p>
          </>
        )
      )}
    </div>
  );
}
