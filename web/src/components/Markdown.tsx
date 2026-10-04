import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Code block with a language label and a copy button (like ChatGPT / Claude). */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const child: any = Array.isArray(children) ? children[0] : children;
  const lang = /language-([\w-]+)/.exec(child?.props?.className ?? "")?.[1] ?? "text";
  const code = String(child?.props?.children ?? "").replace(/\n$/, "");
  return (
    <div className="codeblock">
      <div className="cb-head">
        <span>{lang}</span>
        <button onClick={() => navigator.clipboard?.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); })}>{copied ? "Copied" : "Copy"}</button>
      </div>
      <pre><code>{code}</code></pre>
    </div>
  );
}

/** The bot's answer: Markdown (bold, lists, links, tables, code), no raw HTML, with a typing caret while it streams. */
export function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={`md ${streaming ? "streaming" : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
          table: ({ node: _n, ...p }) => <div className="table-wrap"><table {...p} /></div>,
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
}
