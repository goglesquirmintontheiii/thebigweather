// 0.8.2: small, safe markdown parser for plugin descriptions. It builds a tree that MdView.tsx
// renders as Preact elements — raw HTML is never interpreted (it shows as text), links are http(s)
// only, images are http(s) or files in the plugin folder.
//
// Supported: # headings (1–4), paragraphs, **bold**, *italic* / _italic_, `code`, ```code blocks```,
// [links](https://…), ![images](shot.png), - / * / 1. lists, > quotes, --- rules, | tables |.

export type Inline =
  | { t: "text"; v: string }
  | { t: "b" | "i" | "s"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "a"; href: string; c: Inline[] }
  | { t: "img"; src: string; alt: string }
  | { t: "br" };
export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "pre"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] };

/** resolve a link / image target; null = drop it */
export type Resolver = (url: string, kind: "a" | "img") => string | null;

export const defaultResolver: Resolver = (url, kind) => {
  const u = url.trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (kind === "a" && /^mailto:/i.test(u)) return u;
  return null;
};

export function parseInline(src: string, res: Resolver = defaultResolver, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);
    if (ch === "\\" && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|~>]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i) {
        flush();
        out.push({ t: "code", v: src.slice(i + 1, j) });
        i = j + 1;
        continue;
      }
    }
    if (depth < 4) {
      // images / links
      const m = /^(!?)\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/.exec(rest);
      if (m) {
        flush();
        if (m[1]) {
          const s = res(m[3], "img");
          if (s) out.push({ t: "img", src: s, alt: m[2] });
          else if (m[2]) out.push({ t: "text", v: m[2] });
        } else {
          const h = res(m[3], "a");
          const c = parseInline(m[2], res, depth + 1);
          if (h) out.push({ t: "a", href: h, c });
          else out.push(...c);
        }
        i += m[0].length;
        continue;
      }
      // autolinks <https://…>
      const al = /^<(https?:\/\/[^>\s]+)>/.exec(rest);
      if (al) {
        flush();
        out.push({ t: "a", href: al[1], c: [{ t: "text", v: al[1] }] });
        i += al[0].length;
        continue;
      }
      const em = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest) ?? /^(~~)(?=\S)([\s\S]*?\S)~~/.exec(rest) ?? /^([*_])(?=\S)([\s\S]*?\S)\1(?![*_])/.exec(rest);
      if (em && !(em[1] === "_" && /\w/.test(src[i - 1] ?? ""))) {
        flush();
        out.push({ t: em[1] === "~~" ? "s" : em[1].length === 2 ? "b" : "i", c: parseInline(em[2], res, depth + 1) });
        i += em[0].length;
        continue;
      }
    }
    if (ch === "\n") {
      if (buf.endsWith("  ")) {
        buf = buf.replace(/ +$/, "");
        flush();
        out.push({ t: "br" });
      } else buf += " ";
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}

const splitRow = (l: string) =>
  l
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());

export function parseMarkdown(md: string, res: Resolver = defaultResolver, depth = 0): Block[] {
  const lines = String(md ?? "")
    .replace(/\r\n?/g, "\n")
    .slice(0, 50_000)
    .split("\n");
  const out: Block[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^\s*(#{1,6}\s|```|>|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,}|_{3,})\s*$)/.test(l) || /^\s*\|.*\|\s*$/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*```/.exec(l);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++;
      out.push({ t: "pre", v: body.join("\n") });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(l);
    if (h) {
      out.push({ t: "h", level: Math.min(4, h[1].length), c: parseInline(h[2], res) });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    if (/^\s*>/.test(l)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", c: depth < 3 ? parseMarkdown(body.join("\n"), res, depth + 1) : [{ t: "p", c: [{ t: "text", v: body.join(" ") }] }] });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = splitRow(l).map((c) => parseInline(c, res));
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(splitRow(lines[i++]).map((c) => parseInline(c, res)));
      out.push({ t: "table", head, rows: rows.slice(0, 200) });
      continue;
    }
    const li = /^\s*([-*+]|\d+[.)])\s+/.exec(l);
    if (li) {
      const ordered = /\d/.test(li[1]);
      const items: string[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m && /\d/.test(m[1]) === ordered) items.push(m[2]);
        else if (items.length && lines[i].trim() && /^\s{2,}/.test(lines[i])) items[items.length - 1] += "\n" + lines[i].trim();
        else break;
        i++;
      }
      out.push({ t: ordered ? "ol" : "ul", items: items.map((x) => parseInline(x, res)) });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && isBlockStart(lines[i]))) para.push(lines[i++]);
    out.push({ t: "p", c: parseInline(para.join("\n"), res) });
  }
  return out;
}

/** plain text of the first paragraph (for cards when there's no summary) */
export function firstText(md: string, max = 140): string {
  const b = parseMarkdown(md).find((x) => x.t === "p") as { c: Inline[] } | undefined;
  const txt = (c: Inline[]): string => c.map((x) => (x.t === "text" || x.t === "code" ? x.v : "c" in x ? txt(x.c) : "")).join("");
  const s = b ? txt(b.c) : "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
