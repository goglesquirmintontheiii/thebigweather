// 0.8.3: Settings search. Filters the rendered Settings panel in place (so every section
// component works unchanged): categories → section wrappers (.s83-sec, data-kw) → <section>s →
// their rows. A section whose title / keywords match stays whole; otherwise only matching rows
// stay. Hidden things get the data-sq-hide attribute (Preact leaves unknown attributes alone).

export const HIDE = "data-sq-hide";

/** the minimum of Element this needs (tests pass plain objects) */
export interface FEl {
  readonly children: ArrayLike<FEl>;
  readonly textContent: string | null;
  readonly classList: { contains(c: string): boolean };
  getAttribute(n: string): string | null;
  toggleAttribute(n: string, force?: boolean): boolean;
}

export function queryWords(q: string): string[] {
  return q
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/** every word appears somewhere in the text */
export function matchesAll(words: string[], text: string): boolean {
  const t = text.toLowerCase();
  return words.every((w) => t.includes(w));
}

const kids = (e: FEl) => Array.from(e.children as ArrayLike<FEl>);
const titles = (e: FEl): string => {
  const own = e.getAttribute("title") ?? "";
  return kids(e).reduce((a, c) => a + " " + titles(c), own);
};
const textOf = (e: FEl) => `${e.textContent ?? ""} ${titles(e)}`;
const hide = (e: FEl, h: boolean) => {
  if ((e.getAttribute(HIDE) != null) !== h) e.toggleAttribute(HIDE, h);
};
function unhideAll(e: FEl) {
  hide(e, false);
  kids(e).forEach(unhideAll);
}

/** One section wrapper; returns true when anything in it matches. */
export function filterSection(wrap: FEl, words: string[]): boolean {
  if (!words.length) return (unhideAll(wrap), true);
  const kw = wrap.getAttribute("data-kw") ?? "";
  let any = false;
  for (const sec of kids(wrap)) {
    const rows = kids(sec);
    const heads = rows.filter((r) => r.classList.contains("lbl"));
    const head = `${kw} ${heads.map((h) => h.textContent ?? "").join(" ")}`;
    if (matchesAll(words, `${head}`)) {
      unhideAll(sec);
      any = true;
      continue;
    }
    let hit = false;
    for (const r of rows) {
      if (r.classList.contains("lbl")) continue;
      const ok = matchesAll(words, `${head} ${textOf(r)}`);
      if (ok) unhideAll(r);
      else hide(r, true);
      hit ||= ok;
    }
    // rows that aren't elements of their own (a section rendered as plain text) still count
    if (!rows.length && matchesAll(words, `${head} ${textOf(sec)}`)) hit = true;
    hide(sec, !hit);
    any ||= hit;
  }
  hide(wrap, !any);
  return any;
}

/** Filter a whole category body (its .s83-sec wrappers); returns the number of matching sections. */
export function filterCategory(body: FEl, words: string[]): number {
  let n = 0;
  for (const w of kids(body)) if (w.classList.contains("s83-sec") && filterSection(w, words)) n++;
  return n;
}
