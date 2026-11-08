// 0.8.2: renders the safe markdown tree (mdparse.ts) as Preact elements — never innerHTML.

import { useMemo } from "preact/hooks";
import { parseMarkdown, type Block, type Inline, type Resolver, defaultResolver } from "./mdparse";

function In({ c }: { c: Inline[] }) {
  return (
    <>
      {c.map((x, i) => {
        switch (x.t) {
          case "text":
            return x.v;
          case "b":
            return (
              <strong key={i}>
                <In c={x.c} />
              </strong>
            );
          case "i":
            return (
              <em key={i}>
                <In c={x.c} />
              </em>
            );
          case "s":
            return (
              <s key={i}>
                <In c={x.c} />
              </s>
            );
          case "code":
            return <code key={i}>{x.v}</code>;
          case "a":
            return (
              <a key={i} href={x.href} target="_blank" rel="noopener noreferrer">
                <In c={x.c} />
              </a>
            );
          case "img":
            return <img key={i} src={x.src} alt={x.alt} loading="lazy" referrerpolicy="no-referrer" />;
          case "br":
            return <br key={i} />;
        }
      })}
    </>
  );
}

function Bl({ b }: { b: Block }) {
  switch (b.t) {
    case "h": {
      const H = `h${b.level + 1}` as any; // h1 in the text → h2 on the page (the window title is the h2 above)
      return (
        <H>
          <In c={b.c} />
        </H>
      );
    }
    case "p":
      return (
        <p>
          <In c={b.c} />
        </p>
      );
    case "ul":
    case "ol": {
      const L = b.t as any;
      return (
        <L>
          {b.items.map((it, i) => (
            <li key={i}>
              <In c={it} />
            </li>
          ))}
        </L>
      );
    }
    case "pre":
      return (
        <pre>
          <code>{b.v}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote>
          {b.c.map((x, i) => (
            <Bl key={i} b={x} />
          ))}
        </blockquote>
      );
    case "hr":
      return <hr />;
    case "table":
      return (
        <table>
          <thead>
            <tr>
              {b.head.map((c, i) => (
                <th key={i}>
                  <In c={c} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {b.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>
                    <In c={c} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      );
  }
}

export function Markdown({ src, resolve = defaultResolver, cls = "" }: { src: string; resolve?: Resolver; cls?: string }) {
  const blocks = useMemo(() => parseMarkdown(src, resolve), [src, resolve]);
  return (
    <div class={`md ${cls}`}>
      {blocks.map((b, i) => (
        <Bl key={i} b={b} />
      ))}
    </div>
  );
}
