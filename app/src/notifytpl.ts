// 0.8.1: notification message templates (same rules as the server's notify::render): `{name}` is
// replaced by the message's value, names that aren't placeholders stay as typed. No template (or
// the default `{title}` / `{body}`) sends today's message unchanged.

export const PLACEHOLDERS = ["title", "body", "rule", "event", "headline", "area", "point", "place", "dist", "severity", "level", "time", "expires", "model", "probability", "confidence", "value", "link", "same_code", "station", "min"] as const;
export const DEFAULT_TITLE = "{title}";
export const DEFAULT_BODY = "{body}";
/** short descriptions for the placeholder chips */
export const PH_HELP: Record<string, string> = {
  title: "Default title (rule name)",
  body: "Default message text",
  rule: "Rule name",
  event: "Event (e.g. Tornado Warning)",
  headline: "Alert headline",
  area: "Areas",
  point: "Your point",
  severity: "Severity",
  time: "Time sent",
  expires: "Expires",
  model: "Model",
  probability: "Probability",
  confidence: "Confidence",
  value: "Value",
  link: "Link",
  same_code: "SAME code",
  station: "Radio station",
  dist: "Distance",
};

export interface TplMsg {
  title: string;
  body: string;
  rule?: string;
  level?: string;
  url?: string | null;
  vars: Record<string, any>;
}

export const SAMPLE: TplMsg = {
  title: "Tornado near Home",
  body: "Tornado Warning covers Home",
  rule: "Tornado near Home",
  level: "urgent",
  url: "https://example.com/alert",
  vars: { event: "Tornado Warning", headline: "Tornado Warning issued for Example County until 6:45 PM", area: "Example County", point: "Home", place: "Home", severity: "Extreme", expires: "18:45", dist: "3.2 mi", value: "87", model: "Storm model", probability: "87%", confidence: "high", same_code: "TOR", station: "KEC91" },
};

const nowStr = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function value(m: TplMsg, k: string, now: string): string | null {
  const raw = m.vars?.[k];
  const v = raw == null || raw === "" ? null : String(raw);
  switch (k) {
    case "title":
      return m.title;
    case "body":
      return m.body;
    case "rule":
      return m.rule ?? "";
    case "level":
      return m.level ?? "";
    case "link":
      return m.url ?? v ?? "";
    case "time":
      return v ?? now;
    case "point":
      return v ?? (m.vars?.place != null ? String(m.vars.place) : "");
    case "severity":
      return v ?? m.level ?? "";
  }
  if ((PLACEHOLDERS as readonly string[]).includes(k)) return v ?? "";
  return v;
}

/** Fill a template. */
export function renderTpl(tpl: string, m: TplMsg, now = nowStr()): string {
  return tpl.replace(/\{(\w+)\}/g, (all, k) => value(m, k, now) ?? all);
}

/** The title/body a channel would send: rule templates win over the channel's; blank = default. */
export function applyTpl(m: TplMsg, chan?: { title_tpl?: string; body_tpl?: string }, rule?: { title_tpl?: string; body_tpl?: string }, now?: string): { title: string; body: string } {
  const pick = (r?: string, c?: string) => (r?.trim() ? r : c?.trim() ? c : null);
  const tt = pick(rule?.title_tpl, chan?.title_tpl);
  const bt = pick(rule?.body_tpl, chan?.body_tpl);
  return { title: tt ? renderTpl(tt, m, now).slice(0, 500) : m.title, body: bt ? renderTpl(bt, m, now) : m.body };
}
