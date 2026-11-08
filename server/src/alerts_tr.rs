//! 0.8.3: translate non-English alert text (Hydrometcenter of Russia and other national feeds)
//! to English. No API keys: a free public endpoint chosen by the app (MyMemory by default, the
//! unofficial Google endpoint, or a LibreTranslate server named by `TBW_TRANSLATE_URL`), and
//! when that fails a built-in glossary of Russian warning terms (phenomena, levels, directions,
//! units) with transliteration of the rest, so something readable always comes back.
//! Results are cached in memory (bounded).

use parking_lot::Mutex;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Engine {
    MyMemory,
    Google,
    Libre,
    Glossary,
}

impl Engine {
    pub fn parse(s: &str) -> Engine {
        match s {
            "google" => Engine::Google,
            "libre" => Engine::Libre,
            "glossary" | "off" => Engine::Glossary,
            _ => Engine::MyMemory,
        }
    }
    pub fn id(self) -> &'static str {
        match self {
            Engine::MyMemory => "mymemory",
            Engine::Google => "google",
            Engine::Libre => "libre",
            Engine::Glossary => "glossary",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Engine::MyMemory => "MyMemory",
            Engine::Google => "Google Translate",
            Engine::Libre => "LibreTranslate",
            Engine::Glossary => "Built-in glossary",
        }
    }
}

const CACHE_MAX: usize = 3000;
const TEXT_MAX: usize = 12_000;

#[derive(Default)]
pub struct Translator {
    cache: Mutex<(HashMap<(Engine, String, String), String>, VecDeque<(Engine, String, String)>)>,
}

/// Best guess of the source language from the script (CAP `lang` is preferred when the app sends it).
pub fn detect_lang(text: &str) -> &'static str {
    let (mut cyr, mut lat, mut other) = (0usize, 0usize, [0usize; 6]);
    for c in text.chars().filter(|c| c.is_alphabetic()) {
        match c as u32 {
            0x0400..=0x04FF => cyr += 1,
            0x0041..=0x024F => lat += 1,
            0x0370..=0x03FF => other[0] += 1,
            0x0600..=0x06FF => other[1] += 1,
            0x0590..=0x05FF => other[2] += 1,
            0x3040..=0x30FF => other[3] += 1,
            0x4E00..=0x9FFF => other[4] += 1,
            0xAC00..=0xD7AF => other[5] += 1,
            _ => {}
        }
    }
    let total = cyr + lat + other.iter().sum::<usize>();
    if total == 0 {
        return "en";
    }
    let names = ["el", "ar", "he", "ja", "zh", "ko"];
    let (i, n) = other.iter().enumerate().max_by_key(|(_, n)| **n).unwrap();
    if cyr * 10 >= total * 3 && cyr >= *n {
        return "ru";
    }
    if *n * 10 >= total * 3 {
        // kana with kanji: Japanese
        return if i == 4 && other[3] > 0 { "ja" } else { names[i] };
    }
    "auto"
}

/// Percent-encode for a query string.
fn enc(s: &str) -> String {
    let mut o = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => o.push(b as char),
            _ => o.push_str(&format!("%{b:02X}")),
        }
    }
    o
}

/// Split text into pieces of at most `max` bytes at line / sentence / word boundaries.
pub fn chunks(text: &str, max: usize) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let flush = |cur: &mut String, out: &mut Vec<String>| {
        if !cur.is_empty() {
            out.push(std::mem::take(cur));
        }
    };
    // sentences (keep the separator with the sentence)
    let mut parts: Vec<String> = vec![];
    let mut p = String::new();
    for c in text.chars() {
        p.push(c);
        if matches!(c, '.' | '!' | '?' | '\n' | ';') {
            parts.push(std::mem::take(&mut p));
        }
    }
    if !p.is_empty() {
        parts.push(p);
    }
    for part in parts {
        if cur.len() + part.len() <= max {
            cur.push_str(&part);
            continue;
        }
        flush(&mut cur, &mut out);
        if part.len() <= max {
            cur = part;
            continue;
        }
        // a very long sentence: by words
        for w in part.split_inclusive(' ') {
            if cur.len() + w.len() > max {
                flush(&mut cur, &mut out);
            }
            if w.len() > max {
                // a single huge "word": by chars
                for ch in w.chars() {
                    if cur.len() + ch.len_utf8() > max {
                        flush(&mut cur, &mut out);
                    }
                    cur.push(ch);
                }
            } else {
                cur.push_str(w);
            }
        }
    }
    flush(&mut cur, &mut out);
    out
}

impl Translator {
    fn cached(&self, k: &(Engine, String, String)) -> Option<String> {
        self.cache.lock().0.get(k).cloned()
    }
    fn store(&self, k: (Engine, String, String), v: String) {
        let mut c = self.cache.lock();
        if c.0.insert(k.clone(), v).is_none() {
            c.1.push_back(k);
            while c.1.len() > CACHE_MAX {
                if let Some(old) = c.1.pop_front() {
                    c.0.remove(&old);
                }
            }
        }
    }

    /// Translate `text` (from `from`, "" / "auto" = guess) to English. Returns
    /// `{text, engine, engine_name, from, partial, cached, error?}`; `partial` = glossary result.
    pub async fn translate(&self, http: &reqwest::Client, text: &str, from: &str, engine: Engine) -> Value {
        let text: String = text.chars().take(TEXT_MAX).collect();
        let from = match from.split(['-', '_']).next().unwrap_or("").to_ascii_lowercase().as_str() {
            "" | "auto" | "und" => detect_lang(&text).to_string(),
            l => l.to_string(),
        };
        if from == "en" || text.trim().is_empty() {
            return json!({"text": text, "engine": "none", "engine_name": "", "from": from, "partial": false, "cached": false});
        }
        let key = (engine, from.clone(), text.clone());
        if let Some(t) = self.cached(&key) {
            return json!({"text": t, "engine": engine.id(), "engine_name": engine.label(), "from": from, "partial": engine == Engine::Glossary, "cached": true});
        }
        let mut error = None;
        if engine != Engine::Glossary {
            match self.remote(http, &text, &from, engine).await {
                Ok(t) if !t.trim().is_empty() => {
                    self.store(key, t.clone());
                    return json!({"text": t, "engine": engine.id(), "engine_name": engine.label(), "from": from, "partial": false, "cached": false});
                }
                Ok(_) => error = Some("empty answer".to_string()),
                Err(e) => error = Some(format!("{e:#}").chars().take(160).collect()),
            }
        }
        let g = glossary(&text);
        if engine == Engine::Glossary {
            self.store(key, g.clone());
        }
        json!({"text": g, "engine": "glossary", "engine_name": Engine::Glossary.label(), "from": from, "partial": true, "cached": false, "error": error})
    }

    async fn remote(&self, http: &reqwest::Client, text: &str, from: &str, engine: Engine) -> anyhow::Result<String> {
        let to = Duration::from_secs(20);
        let mut out = String::new();
        match engine {
            Engine::MyMemory => {
                // 500 bytes per request; anonymous quota is a few thousand words a day
                let src = if from == "auto" { "Autodetect" } else { from };
                for c in chunks(text, 480) {
                    let url = format!("https://api.mymemory.translated.net/get?q={}&langpair={}%7Cen", enc(&c), enc(src));
                    let v: Value = http.get(&url).timeout(to).send().await?.error_for_status()?.json().await?;
                    let st = v["responseStatus"].as_i64().or_else(|| v["responseStatus"].as_str().and_then(|s| s.parse().ok())).unwrap_or(200);
                    if st != 200 {
                        anyhow::bail!("MyMemory: {}", v["responseDetails"].as_str().unwrap_or("error"));
                    }
                    let t = v["responseData"]["translatedText"].as_str().unwrap_or("");
                    if t.contains("MYMEMORY WARNING") || t.contains("QUERY LENGTH LIMIT") {
                        anyhow::bail!("MyMemory: daily limit reached");
                    }
                    out.push_str(t);
                    if !t.ends_with(char::is_whitespace) && c.ends_with(char::is_whitespace) {
                        out.push(if c.ends_with('\n') { '\n' } else { ' ' });
                    }
                }
            }
            Engine::Google => {
                let sl = if from == "auto" { "auto" } else { from };
                for c in chunks(text, 1800) {
                    let url = format!("https://translate.googleapis.com/translate_a/single?client=gtx&sl={}&tl=en&dt=t&q={}", enc(sl), enc(&c));
                    let v: Value = http.get(&url).timeout(to).send().await?.error_for_status()?.json().await?;
                    out.push_str(&google_text(&v));
                }
            }
            Engine::Libre => {
                let base = std::env::var("TBW_TRANSLATE_URL").map_err(|_| anyhow::anyhow!("no LibreTranslate server set (TBW_TRANSLATE_URL)"))?;
                let url = format!("{}/translate", base.trim_end_matches('/').trim_end_matches("/translate"));
                let mut body = json!({"q": text, "source": if from == "auto" { "auto" } else { from }, "target": "en", "format": "text"});
                if let Ok(k) = std::env::var("TBW_TRANSLATE_KEY") {
                    body["api_key"] = json!(k);
                }
                let v: Value = http.post(&url).json(&body).timeout(to).send().await?.error_for_status()?.json().await?;
                out = v["translatedText"].as_str().unwrap_or("").to_string();
            }
            Engine::Glossary => {}
        }
        Ok(out)
    }
}

/// `[[["Hello","Привет",…],…],…]` → "Hello…"
pub fn google_text(v: &Value) -> String {
    v.get(0).and_then(|a| a.as_array()).map(|a| a.iter().filter_map(|s| s.get(0).and_then(|t| t.as_str())).collect::<String>()).unwrap_or_default()
}

// ---------- glossary ----------

/// Whole words (lower case).
const WORDS: &[(&str, &str)] = &[
    ("и", "and"), ("в", "in"), ("во", "in"), ("на", "on"), ("с", "from"), ("со", "with"), ("до", "up to"), ("от", "from"), ("по", "across"),
    ("при", "with"), ("к", "by"), ("за", "over"), ("из", "from"), ("не", "not"), ("или", "or"), ("местами", "locally"), ("ночью", "at night"),
    ("днем", "during the day"), ("днём", "during the day"), ("утром", "in the morning"), ("вечером", "in the evening"), ("очень", "very"),
    ("м/с", "m/s"), ("мм", "mm"), ("см", "cm"), ("км", "km"), ("ч", "h"), ("час", "hour"), ("часа", "hours"), ("часов", "hours"), ("сутки", "24 hours"),
    ("сель", "mudflow"), ("сели", "mudflows"), ("град", "hail"), ("града", "hail"), ("градом", "hail"), ("гроза", "thunderstorm"), ("грозы", "thunderstorms"),
    ("ветер", "wind"), ("ветра", "wind"), ("ветром", "wind"), ("буря", "storm"), ("бури", "storms"), ("бурей", "storm"), ("туман", "fog"), ("тумана", "fog"),
    ("край", "krai"), ("края", "krai"), ("крае", "krai"), ("ао", "AO"), ("мск", "MSK"), ("ожидается", "expected"), ("ожидаются", "expected"),
    ("сохранится", "will persist"), ("сохранятся", "will persist"), ("отдельных", "some"), ("районах", "areas"), ("районы", "districts"),
    ("суток", "day"), ("река", "river"), ("реки", "rivers"), ("рек", "rivers"), ("море", "sea"), ("моря", "sea"), ("морях", "seas"), ("ниже", "below"), ("выше", "above"), ("более", "more than"), ("менее", "less than"),
];

/// Stems (lower case, longest match wins).
const STEMS: &[(&str, &str)] = &[
    // phenomena
    ("гроз", "thunderstorm"), ("ливн", "heavy shower"), ("ливен", "heavy shower"), ("дожд", "rain"), ("снегопад", "snowfall"),
    ("снег", "snow"), ("снеж", "snow"), ("метел", "snowstorm"), ("метель", "snowstorm"), ("буран", "blizzard"), ("вьюг", "blizzard"), ("гололедиц", "black ice"),
    ("гололед", "glaze ice"), ("гололёд", "glaze ice"), ("налипан", "accretion"), ("изморозь", "rime"), ("изморос", "drizzle"), ("туман", "fog"),
    ("заморозк", "frost"), ("мороз", "frost"), ("похолодан", "cold snap"), ("жар", "heat"), ("зно", "heat"), ("ветр", "wind"), ("ветер", "wind"),
    ("порыв", "gusts"), ("шквал", "squall"), ("смерч", "tornado"), ("торнадо", "tornado"), ("пожароопасн", "fire danger"), ("пожар", "fire"),
    ("наводнен", "flood"), ("паводк", "flood"), ("паводок", "flood"), ("половод", "spring flood"), ("подтоплен", "flooding"), ("затоплен", "flooding"),
    ("лавин", "avalanche"), ("селев", "mudflow"), ("осадк", "precipitation"), ("шторм", "storm"), ("волнен", "rough sea"), ("цунами", "tsunami"),
    ("пыльн", "dust"), ("гололедно-изморозев", "icing"), ("мокр", "wet"), ("крупн", "large"), ("видимост", "visibility"), ("температур", "temperature"),
    ("аномальн", "abnormal"), ("холод", "cold"), ("тепл", "warm"), ("сильн", "strong"), ("усилен", "strengthening"), ("продолжительн", "prolonged"),
    ("количеств", "amount"), ("гололедн", "icy"), ("лед", "ice"), ("лёд", "ice"), ("ледян", "ice"),
    // levels, wording
    ("красн", "red"), ("оранжев", "orange"), ("желт", "yellow"), ("жёлт", "yellow"), ("зелен", "green"), ("зелён", "green"), ("уровн", "level"),
    ("уровень", "level"), ("опасн", "dangerous"), ("неблагоприятн", "adverse"), ("предупрежден", "warning"), ("штормов", "storm"), ("экстренн", "emergency"),
    ("чрезвычайн", "extreme"), ("явлен", "phenomenon"), ("ожида", "expected"), ("прогноз", "forecast"), ("внимани", "attention"), ("осторожн", "caution"),
    ("угроз", "threat"), ("риск", "risk"), ("возможн", "possible"), ("вероятн", "likely"), ("местам", "locally"), ("градус", "degrees"),
    ("минут", "minutes"), ("метр", "m"), ("километр", "km"), ("сутк", "day"), ("ночь", "night"), ("дн", "day"),
    // places, directions
    ("северо-запад", "northwest"), ("северо-восто", "northeast"), ("юго-запад", "southwest"), ("юго-восто", "southeast"), ("север", "north"),
    ("южн", "south"), ("юг", "south"), ("запад", "west"), ("восто", "east"), ("област", "oblast"), ("республик", "republic"), ("район", "district"),
    ("город", "city"), ("побережь", "coast"), ("горн", "mountain"), ("гор", "mountains"), ("территори", "territory"), ("округ", "okrug"), ("морск", "sea"),
    ("озер", "lake"), ("автономн", "autonomous"), ("федерал", "federal"), ("опасност", "danger"),
];

fn translit(w: &str) -> String {
    let mut o = String::new();
    for c in w.chars() {
        let up = c.is_uppercase();
        let l: String = c.to_lowercase().collect();
        let t = match l.as_str() {
            "а" => "a", "б" => "b", "в" => "v", "г" => "g", "д" => "d", "е" => "e", "ё" => "yo", "ж" => "zh", "з" => "z", "и" => "i", "й" => "y",
            "к" => "k", "л" => "l", "м" => "m", "н" => "n", "о" => "o", "п" => "p", "р" => "r", "с" => "s", "т" => "t", "у" => "u", "ф" => "f",
            "х" => "kh", "ц" => "ts", "ч" => "ch", "ш" => "sh", "щ" => "shch", "ъ" => "", "ы" => "y", "ь" => "", "э" => "e", "ю" => "yu", "я" => "ya",
            "і" => "i", "ї" => "yi", "є" => "ye", "ў" => "w", "ә" => "a", "ғ" => "g", "қ" => "q", "ң" => "ng", "ө" => "o", "ұ" => "u", "ү" => "u", "һ" => "h",
            _ => "",
        };
        if t.is_empty() && !l.chars().all(|x| ('\u{0400}'..='\u{04FF}').contains(&x)) {
            o.push(c);
            continue;
        }
        if up {
            let mut cs = t.chars();
            if let Some(f) = cs.next() {
                o.extend(f.to_uppercase());
                o.push_str(cs.as_str());
            }
        } else {
            o.push_str(t);
        }
    }
    o
}

fn cap(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// One Cyrillic word → English (glossary) or a transliteration.
fn word(w: &str) -> String {
    let l = w.to_lowercase();
    let upper = w.chars().next().is_some_and(|c| c.is_uppercase());
    let all_caps = w.chars().count() > 1 && w.chars().all(|c| !c.is_lowercase());
    let hit = WORDS.iter().find(|(k, _)| *k == l).map(|(_, v)| *v).or_else(|| STEMS.iter().filter(|(k, _)| l.starts_with(k) && k.chars().count() >= 2).max_by_key(|(k, _)| k.chars().count()).map(|(_, v)| *v));
    match hit {
        Some(v) if all_caps => v.to_uppercase(),
        Some(v) if upper => cap(v),
        Some(v) => v.to_string(),
        None => translit(w),
    }
}

fn is_cyr(c: char) -> bool {
    ('\u{0400}'..='\u{04FF}').contains(&c)
}

/// Built-in glossary translation: known Russian warning terms in English, other Cyrillic words
/// transliterated, everything else (numbers, punctuation, Latin) kept.
pub fn glossary(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let cs: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        if is_cyr(cs[i]) {
            let mut j = i;
            // words may contain an inner hyphen (северо-западный)
            while j < cs.len() && (is_cyr(cs[j]) || (cs[j] == '-' && j + 1 < cs.len() && is_cyr(cs[j + 1]) && j > i)) {
                j += 1;
            }
            let w: String = cs[i..j].iter().collect();
            // "м/с"
            if (w == "м" || w == "М") && j + 1 < cs.len() && cs[j] == '/' && (cs[j + 1] == 'с' || cs[j + 1] == 'С') {
                out.push_str("m/s");
                i = j + 2;
                continue;
            }
            // two-word phrases
            let rest: String = cs[j..].iter().take(24).collect();
            let lw = w.to_lowercase();
            if lw == "в" && rest.to_lowercase().starts_with(" течение") {
                out.push_str(if w == "В" { "During" } else { "during" });
                i = j + " течение".chars().count();
                continue;
            }
            // "сильный": strong wind, severe frost, heavy rain / snow
            if lw.starts_with("сильн") || lw.starts_with("очень сильн") {
                let next: String = rest.trim_start_matches(|c: char| c == ' ').chars().take_while(|c| is_cyr(*c)).collect::<String>().to_lowercase();
                let en = if ["ветр", "ветер", "порыв", "шквал", "волнен", "шторм"].iter().any(|k| next.starts_with(k)) {
                    "strong"
                } else if ["мороз", "жар", "зно", "холод"].iter().any(|k| next.starts_with(k)) {
                    "severe"
                } else {
                    "heavy"
                };
                out.push_str(&if w.chars().count() > 1 && w.chars().all(|c| !c.is_lowercase()) { en.to_uppercase() } else if w.starts_with(char::is_uppercase) { cap(en) } else { en.to_string() });
                i = j;
                continue;
            }
            out.push_str(&word(&w));
            i = j;
        } else {
            out.push(cs[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_scripts() {
        assert_eq!(detect_lang("Сильный ветер 25 м/с"), "ru");
        assert_eq!(detect_lang("Strong wind"), "auto");
        assert_eq!(detect_lang("12 34"), "en");
        assert_eq!(detect_lang("Ισχυροί άνεμοι"), "el");
        assert_eq!(detect_lang("強風注意報"), "zh");
        assert_eq!(detect_lang("強風に注意"), "ja");
    }

    #[test]
    fn glossary_translates_warning_terms() {
        let t = glossary("Сильный ветер, порывы 25-30 м/с. Гроза, град. Оранжевый уровень опасности.");
        assert!(t.starts_with("Strong wind, gusts 25-30 m/s."), "{t}");
        assert!(t.contains("Thunderstorm, hail."), "{t}");
        assert!(t.contains("Orange level danger."), "{t}");
        assert_eq!(glossary("Сильный дождь, сильный мороз"), "Heavy rain, severe frost");
        assert!(!t.chars().any(is_cyr), "{t}");
        // place names are transliterated, Latin / numbers kept
        assert_eq!(glossary("Москва"), "Moskva");
        assert_eq!(glossary("в течение суток"), "during day");
        assert_eq!(glossary("ГРОЗА (CAP)"), "THUNDERSTORM (CAP)");
        assert_eq!(glossary("северо-западный ветер"), "northwest wind");
        assert_eq!(glossary("Hello 12"), "Hello 12");
    }

    #[test]
    fn chunks_split_on_sentences_within_limit() {
        let s = "Сильный ветер. ".repeat(60);
        let cs = chunks(&s, 480);
        assert!(cs.len() > 1);
        assert!(cs.iter().all(|c| c.len() <= 480));
        assert_eq!(cs.concat(), s);
        let long = "слово ".repeat(200);
        assert!(chunks(&long, 100).iter().all(|c| c.len() <= 100));
        assert_eq!(chunks(&long, 100).concat(), long);
    }

    #[test]
    fn google_answer_is_joined() {
        let v: Value = serde_json::from_str(r#"[[["Strong wind. ","Сильный ветер. ",null,null,10],["Hail.","Град.",null,null,10]],null,"ru"]"#).unwrap();
        assert_eq!(google_text(&v), "Strong wind. Hail.");
        assert_eq!(enc("a b/ж"), "a%20b%2F%D0%B6");
    }

    #[tokio::test]
    async fn glossary_engine_and_cache() {
        let t = Translator::default();
        let http = reqwest::Client::new();
        let a = t.translate(&http, "Сильный дождь", "ru", Engine::Glossary).await;
        assert_eq!(a["text"], "Heavy rain");
        assert_eq!(a["partial"], true);
        assert_eq!(a["cached"], false);
        let b = t.translate(&http, "Сильный дождь", "ru-RU", Engine::Glossary).await;
        assert_eq!(b["cached"], true);
        // English passes through
        let c = t.translate(&http, "Strong rain", "en", Engine::MyMemory).await;
        assert_eq!(c["engine"], "none");
        assert_eq!(c["text"], "Strong rain");
    }
}
