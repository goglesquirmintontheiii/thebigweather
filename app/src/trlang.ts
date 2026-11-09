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

// common Spanish words in warnings, and English ones to tell the two apart. Place names like
// "Las Vegas" or "El Paso" give one or two Spanish hits at most, against many English ones.
const ES = new Set("el la los las de del en y por para con se una un que al muy lluvia lluvias tormenta tormentas viento vientos granizo nieve oleaje aviso alerta fuerte fuertes intensa intensas intenso intensos zona zonas probabilidad precipitaciones temperatura temperaturas descargas electricas inundaciones calor frio torrenciales rachas".split(" "));
const EN = new Set("the of and in for to with is are will be at from by this until warning watch advisory wind winds rain storm storms expected issued heavy flood snow".split(" "));

/** Latin text that reads as Spanish (feeds often leave the language out or say "en") */
export function looksSpanish(text: string): boolean {
  let es = 0, en = 0;
  for (const w of text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().split(/[^\p{L}]+/u)) {
    if (ES.has(w)) es++;
    else if (EN.has(w)) en++;
  }
  return es >= 2 && es > en * 2;
}

/** the alert's language: CAP `lang` when given, else guessed from the text ("" = English / unknown Latin) */
export function alertLang(p: { lang?: string; description?: string; headline?: string; event?: string }): string {
  const l = (p.lang ?? "").toLowerCase().split(/[-_]/)[0];
  const s = scriptLang(`${p.headline ?? ""} ${p.description ?? ""}`);
  // feeds label their documents "en" even when the text is Russian (Hydrometcenter)
  if (s === "ru") return "ru";
  if (s === "other") return l && l !== "en" ? l : "auto";
  if (l && l !== "en") return l;
  return s === "latin" && looksSpanish(`${p.event ?? ""} ${p.headline ?? ""} ${p.description ?? ""}`) ? "es" : "";
}

/** offer Translate: mode "ru" = Russian and Spanish alerts (default; 0.8.4 added Spanish), "all" = any non-English, "off" */
export function offerTranslate(mode: string | undefined, p: Parameters<typeof alertLang>[0]): string | null {
  if (mode === "off") return null;
  const l = alertLang(p);
  if (!l) return null;
  if ((mode ?? "ru") === "ru" && l !== "ru" && l !== "es") return null;
  return l;
}

export const TR_ENGINES: [string, string][] = [
  ["mymemory", "MyMemory (free, default)"],
  ["google", "Google Translate (free, unofficial)"],
  ["libre", "LibreTranslate (server's TBW_TRANSLATE_URL)"],
  ["glossary", "Built-in glossary only (offline)"],
];
