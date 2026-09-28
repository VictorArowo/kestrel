import Link from "next/link";
import { Fragment, type ReactNode } from "react";

/** Just enough Markdown for agent replies: paragraphs, lists, **bold**, `code` and links within the app. No HTML. */
export function Markdown({ text }: { text: string }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className="prose-agent">
      {blocks.map((block, i) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*]|\d+\.)\s+/.test(l))) {
          return (
            <ul key={i}>
              {lines.map((l, j) => (
                <li key={j}>{inline(l.replace(/^\s*([-*]|\d+\.)\s+/, ""))}</li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            {lines.map((l, j) => (
              <Fragment key={j}>
                {j > 0 && <br />}
                {inline(l.replace(/^#+\s+/, ""))}
              </Fragment>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) out.push(<strong key={m.index}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith("`")) out.push(<code key={m.index}>{tok.slice(1, -1)}</code>);
    else {
      const [, label, href] = tok.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      // Only links inside the app; anything else stays plain text.
      out.push(
        href.startsWith("/") && !href.startsWith("//") ? (
          <Link key={m.index} href={href} className="text-amber hover:underline">
            {label}
          </Link>
        ) : (
          label
        ),
      );
    }
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
