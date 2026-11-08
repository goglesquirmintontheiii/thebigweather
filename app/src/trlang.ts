// 0.8.3: which alerts get a Translate button. Pure (no DOM / store imports) for tests.

/** "ru", "el", "ar", "zh" … from the script, "latin" for Latin text, "" when there are no letters */
export function scriptLang(text: string): string {
  let cyr = 0, lat = 0, other = 0, total = 0;
  for (const c of text) {
    if (!/\p{L}/u.test(c)) continue;
    total++;
    const n = c.codePointAt(0)!;
    if (n >= 0x400 && n <= 0x4ff) cyr++;
    else if (n <= 0x24f) lat++;
    else other++;
  }
  if (!total) return "";
  if (cyr * 10 >= total * 3) return "ru";
  if (other * 10 >= total * 3) return "other";
  return lat ? "latin" : "";
}

/** the alert's language: CAP `lang` when given, else guessed from the text ("" = English / unknown Latin) */
export function alertLang(p: { lang?: string; description?: string; headline?: string; event?: string }): string {
  const l = (p.lang ?? "").toLowerCase().split(/[-_]/)[0];
  const s = scriptLang(`${p.headline ?? ""} ${p.description ?? ""}`);
  // feeds label their documents "en" even when the text is Russian (Hydrometcenter)
  if (s === "ru") return "ru";
  if (s === "other") return l && l !== "en" ? l : "auto";
  return l && l !== "en" ? l : "";
}

/** offer Translate: mode "ru" = Russian (Cyrillic) alerts only (default), "all" = any non-English, "off" */
export function offerTranslate(mode: string | undefined, p: Parameters<typeof alertLang>[0]): string | null {
  if (mode === "off") return null;
  const l = alertLang(p);
  if (!l) return null;
  if ((mode ?? "ru") === "ru" && l !== "ru") return null;
  return l;
}

export const TR_ENGINES: [string, string][] = [
  ["mymemory", "MyMemory (free, default)"],
  ["google", "Google Translate (free, unofficial)"],
  ["libre", "LibreTranslate (server's TBW_TRANSLATE_URL)"],
  ["glossary", "Built-in glossary only (offline)"],
];
