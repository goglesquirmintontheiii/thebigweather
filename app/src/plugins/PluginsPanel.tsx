// 0.8.2: the Plugins rail tab — Installed / Marketplace / Updates, search, plugin cards, and a
// detail window (banner, screenshots, markdown description, permissions, install / update / remove).

import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { Puzzle, Search, RefreshCw, Download, Trash2, ChevronLeft, ChevronRight, AlertTriangle, Upload, ClipboardPaste, Link, FolderOpen, Settings2, ExternalLink, Check, CircleArrowUp, Plus, X, GitFork } from "lucide-preact";
import { ToggleLeft, ToggleRight, Info } from "lucide-preact"; // 0.8.3
import { settings, toast, type PluginCfg } from "../store";
import { CenterModal } from "../ui/CenterModal";
import { pluginStatus, addPlugin, reloadPlugin, pluginFolder } from "./host";
import { market, installedMeta, busy, refreshMarket, loadInstalledMeta, install, uninstall, setEnabled, updates, description, registries, setRegistries, type MarketItem, type InstalledMeta } from "./market";
import { assetUrl, matches, PERMISSIONS, DEFAULT_REGISTRY, cmpVersion, cardBgUrl, type Manifest } from "./marketcore";
import { Markdown } from "./MdView";
import { firstText, type Resolver } from "./mdparse";
import "./plugins.css";

type Tab = "installed" | "market" | "updates";
export const pluginsTab = signal<Tab>("market");
/** the plugin shown in the detail window: a marketplace key or an installed plugin id */
export const pluginDetail = signal<{ key?: string; id?: string } | null>(null);

/** one row of the list, from the marketplace and / or the installed list */
interface View {
  key: string;
  m?: Manifest;
  name: string;
  summary: string;
  author?: string;
  icon?: string | null;
  item?: MarketItem;
  cfg?: PluginCfg;
  meta?: InstalledMeta;
  update?: boolean;
  error?: string;
  /** 0.8.3: card background image */
  bg?: string | null;
}

function views(): View[] {
  const items = market.value.items;
  const list = settings.value.wf6.plugins;
  const meta = installedMeta.value;
  const out: View[] = [];
  const used = new Set<string>();
  for (const it of items) {
    const m = it.manifest;
    const cfg = m ? list.find((p) => p.market?.pid === m.id) : undefined;
    if (cfg) used.add(cfg.id);
    out.push({
      key: it.key,
      m,
      name: m?.name ?? it.entry.name ?? it.entry.repo ?? it.entry.path ?? "Plugin",
      summary: m?.summary ?? it.entry.summary ?? (m?.description && !/\.md$/i.test(m.description) ? firstText(m.description) : "") ?? "",
      author: m?.author,
      icon: m?.icon ? assetUrl(it.base, m.icon) : null,
      item: it,
      cfg,
      meta: cfg ? meta[cfg.id] : undefined,
      update: !!(m && cfg?.market && cmpVersion(m.version, cfg.market.version) > 0),
      error: it.error,
      bg: cardBgUrl(m, it.base) ?? (cfg ? meta[cfg.id]?.cardBg : null), // 0.8.3
    });
  }
  for (const p of list) {
    if (used.has(p.id)) continue;
    const mm = meta[p.id];
    out.push({
      key: `id:${p.id}`,
      m: mm?.manifest,
      name: p.name,
      summary: mm?.manifest.summary ?? (p.market ? "Not in the current marketplace list" : p.src.replace(/^(\w+):/, "$1 · ")),
      author: mm?.manifest.author,
      icon: mm?.icon ?? (mm?.manifest.icon ? assetUrl(mm.base, mm.manifest.icon) : null),
      cfg: p,
      meta: mm,
      bg: mm?.cardBg ?? (mm ? cardBgUrl(mm.manifest, mm.base) : null), // 0.8.3
    });
  }
  return out;
}

function Icon({ src, size = 40 }: { src?: string | null; size?: number }) {
  const [bad, setBad] = useState(false);
  return (
    <span class="plgm-icon" style={{ width: `${size}px`, height: `${size}px` }}>
      {src && !bad ? <img src={src} alt="" onError={() => setBad(true)} /> : <Puzzle size={Math.round(size * 0.5)} />}
    </span>
  );
}

function statusOf(cfg?: PluginCfg): { cls: string; text: string } | null {
  if (!cfg) return null;
  const st = pluginStatus.value[cfg.id];
  if (st?.error) return { cls: "err", text: "Error" };
  if (!cfg.on) return { cls: "off", text: "Disabled" };
  return { cls: "on", text: "Installed" };
}

/* ---------- 0.8.3: right-click menu on a plugin card (like the map's) ---------- */
const cardMenu = signal<{ key: string; x: number; y: number } | null>(null);
const openDetail = (v: View) => (pluginDetail.value = v.item ? { key: v.key } : { id: v.cfg!.id });

function CardMenu() {
  const m = cardMenu.value;
  const [sure, setSure] = useState(false);
  useEffect(() => {
    setSure(false);
    if (!m) return;
    const close = (e: Event) => {
      if (!(e.target as HTMLElement)?.closest?.(".plgm-menu")) cardMenu.value = null;
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (cardMenu.value = null);
    const off = () => (cardMenu.value = null);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", off);
    window.addEventListener("resize", off);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", off);
      window.removeEventListener("resize", off);
    };
  }, [m]);
  if (!m) return null;
  const v = views().find((x) => x.key === m.key);
  if (!v) return null;
  const cfg = v.cfg;
  const act = (fn: () => any) => () => {
    cardMenu.value = null;
    Promise.resolve()
      .then(fn)
      .catch((e) => toast(`${v.name}: ${e?.message ?? e}`, "error", 7000));
  };
  const n = 2 + (cfg ? 2 : 0) + (v.update || (!cfg && v.item?.manifest) ? 1 : 0);
  return createPortal(
    <div class="ctx glass plgm-menu" role="menu" style={{ left: `${Math.min(m.x + 4, window.innerWidth - 210)}px`, top: `${Math.min(m.y + 4, window.innerHeight - 34 * n - 40)}px` }}>
      <div class="ctx-title">
        <b>{v.name}</b>
        {v.m?.version ? ` · v${v.m.version}` : ""}
      </div>
      {cfg && (
        <button role="menuitem" onClick={act(() => (setEnabled(cfg.id, !cfg.on), toast(`${v.name} ${cfg.on ? "disabled" : "enabled"}`, "info", 1500)))}>
          {cfg.on ? <ToggleRight size={13} /> : <ToggleLeft size={13} />} {cfg.on ? "Disable" : "Enable"}
        </button>
      )}
      {!cfg && v.item?.manifest && (
        <button role="menuitem" onClick={act(() => install(v.item!).then(() => toast(`${v.name} installed`)))}>
          <Download size={13} /> Install
        </button>
      )}
      {cfg && v.update && v.item && (
        <button role="menuitem" onClick={act(() => install(v.item!).then(() => toast(`${v.name} updated`)))}>
          <CircleArrowUp size={13} /> Update to v{v.m?.version}
        </button>
      )}
      <button role="menuitem" onClick={act(() => openDetail(v))}>
        <Info size={13} /> Details
      </button>
      {cfg && <div class="ctx-sep" />}
      {cfg &&
        (sure ? (
          <button role="menuitem" class="danger" onClick={act(() => uninstall(cfg.id).then(() => toast(`${v.name} uninstalled`, "info", 1800)))}>
            <Trash2 size={13} /> Click again to uninstall
          </button>
        ) : (
          <button role="menuitem" class="danger" onClick={() => setSure(true)}>
            <Trash2 size={13} /> Uninstall…
          </button>
        ))}
    </div>,
    document.body,
  );
}

function Card({ v }: { v: View }) {
  const s = statusOf(v.cfg);
  return (
    <button
      class={`plgm-card${v.error ? " bad" : ""}${v.bg ? " has-bg" : ""}`}
      style={v.bg ? { "--plgm-bg": `url("${v.bg.replace(/["\\\n]/g, "")}")` } : undefined}
      onClick={() => openDetail(v)}
      onContextMenu={(e) => {
        e.preventDefault();
        cardMenu.value = { key: v.key, x: e.clientX, y: e.clientY };
      }}
      title="Details · right-click for more"
    >
      <Icon src={v.icon} />
      <span class="plgm-card-txt">
        <b>{v.name}</b>
        <small class="plgm-sum">{v.error ? v.error : v.summary || " "}</small>
        <small class="muted">
          {v.author ? `by ${v.author}` : v.item?.source === "repo" ? v.item.entry.repo : ""}
          {v.m?.version ? ` · v${v.m.version}` : ""}
        </small>
      </span>
      <span class="plgm-badges">
        {v.update && <span class="plgm-badge upd">Update</span>}
        {s && <span class={`plgm-badge ${s.cls}`}>{s.text}</span>}
      </span>
    </button>
  );
}

export function PluginsPanel() {
  const tab = pluginsTab.value;
  const [q, setQ] = useState("");
  useEffect(() => {
    loadInstalledMeta();
    if (!market.peek().at) refreshMarket();
  }, []);
  const all = views();
  const nUpd = updates.value.length;
  const shown = all
    .filter((v) => (tab === "installed" ? !!v.cfg : tab === "updates" ? v.update : !!v.item))
    .filter((v) => !q.trim() || (v.m ? matches(v.m, q) : v.name.toLowerCase().includes(q.toLowerCase())));
  const mk = market.value;
  return (
    <div class="plgm">
      <div class="plg-warn">
        <AlertTriangle size={14} />
        <span>Plugins run code with full access to the app, your settings and the server. Only install plugins you trust.</span>
      </div>
      <div class="seg plgm-tabs">
        <button class={tab === "installed" ? "on" : ""} onClick={() => (pluginsTab.value = "installed")}>
          Installed {settings.value.wf6.plugins.length > 0 && <span class="plgm-n">{settings.value.wf6.plugins.length}</span>}
        </button>
        <button class={tab === "market" ? "on" : ""} onClick={() => (pluginsTab.value = "market")}>
          Marketplace
        </button>
        <button class={tab === "updates" ? "on" : ""} onClick={() => (pluginsTab.value = "updates")}>
          Updates {nUpd > 0 && <span class="plgm-n upd">{nUpd}</span>}
        </button>
      </div>
      <div class="plgm-search">
        <Search size={14} />
        <input placeholder="Search plugins" value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
        <button class="icon-btn" title="Refresh marketplace" disabled={mk.loading} onClick={() => refreshMarket()}>
          <RefreshCw size={14} class={mk.loading ? "spin" : ""} />
        </button>
      </div>
      {mk.errors.map((e) => (
        <div key={e.reg} class="plgm-err small">
          Couldn't load {e.reg === DEFAULT_REGISTRY ? "the marketplace" : e.reg}: {e.msg}
        </div>
      ))}
      {mk.loading && !mk.items.length && <div class="muted small">Loading marketplace…</div>}
      <div class="plgm-list">
        {shown.map((v) => (
          <Card key={v.key} v={v} />
        ))}
        {!shown.length && !mk.loading && <div class="muted small plgm-empty">{tab === "updates" ? "Everything is up to date." : tab === "installed" ? "No plugins installed yet." : q ? "No matches." : "No plugins found."}</div>}
      </div>
      {tab === "updates" && nUpd > 1 && (
        <button class="btn sm" onClick={async () => {
          for (const it of updates.peek()) await install(it).catch((e) => toast(`${it.manifest?.name}: ${e.message}`, "error"));
          toast("Plugins updated");
        }}>
          <CircleArrowUp size={13} /> Update all
        </button>
      )}
      {tab === "installed" && <AddOwn />}
      {tab === "market" && <Registries />}
      <div class="muted small">
        Plugin API and how to publish: <a href="https://github.com/goglesquirmintontheiii/thebigweather/tree/main/plugins" target="_blank" rel="noopener noreferrer">plugins/README.md</a>
      </div>
      {pluginDetail.value && createPortal(<Detail />, document.body)}
      <CardMenu />

    </div>
  );
}

/* ---------- add your own (file / URL / paste / plugin folder) — moved here from Settings ---------- */
function AddOwn() {
  const list = settings.value.wf6.plugins;
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [paste, setPaste] = useState<string | null>(null);
  const [folder, setFolder] = useState<{ dir: string; files: { name: string; code: string }[] } | null>(null);
  useEffect(() => {
    if (open) pluginFolder().then(setFolder);
  }, [open]);
  const fromFile = () => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = ".js,.mjs,text/javascript";
    i.onchange = async () => {
      const f = i.files?.[0];
      if (f) await addPlugin(f.name, `file:${f.name}`, await f.text());
    };
    i.click();
  };
  const fromUrl = async () => {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await addPlugin(url.split("/").pop() || "plugin", `url:${url}`, await r.text());
      setUrl("");
    } catch (e: any) {
      toast(`Couldn't load: ${e.message}`, "error");
    }
  };
  if (!open)
    return (
      <button class="btn sm ghost plgm-addown" onClick={() => setOpen(true)}>
        <Plus size={13} /> Add your own (.js file, URL, code)
      </button>
    );
  return (
    <div class="plgm-box">
      <div class="plgm-box-h">
        <b>Add your own</b>
        <button class="icon-btn" title="Close" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div class="row">
        <button class="btn sm ghost" onClick={fromFile}>
          <Upload size={13} /> Load .js file
        </button>
        <button class="btn sm ghost" onClick={() => setPaste(paste === null ? "" : null)}>
          <ClipboardPaste size={13} /> Paste code
        </button>
      </div>
      <div class="row">
        <input placeholder="https://…/plugin.js" value={url} onInput={(e) => setUrl((e.target as HTMLInputElement).value)} />
        <button class="btn sm ghost" disabled={!/^https?:\/\//.test(url)} onClick={fromUrl}>
          <Link size={13} /> Add
        </button>
      </div>
      {paste !== null && (
        <>
          <textarea class="plg-code" rows={7} placeholder={"tbw.toast('hello');\n// or: export default function (tbw) { … }"} value={paste} onInput={(e) => setPaste((e.target as HTMLTextAreaElement).value)} />
          <button class="btn sm" disabled={!paste.trim()} onClick={() => addPlugin(`Pasted ${list.length + 1}`, "paste", paste!).then(() => setPaste(null))}>
            Add plugin
          </button>
        </>
      )}
      {folder && (
        <div class="muted small">
          <FolderOpen size={12} /> Plugin folder: {folder.dir}
          {folder.files
            .filter((f) => !list.some((p) => p.src === `folder:${f.name}`))
            .map((f) => (
              <button key={f.name} class="chip" onClick={() => addPlugin(f.name, `folder:${f.name}`, f.code)}>
                + {f.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/* ---------- marketplace sources ---------- */
function Registries() {
  const [open, setOpen] = useState(false);
  const [txt, setTxt] = useState("");
  const custom = !!settings.value.wf6.pluginRegistries?.length;
  if (!open)
    return (
      <button class="btn sm ghost plgm-addown" onClick={() => (setTxt(registries().join("\n")), setOpen(true))}>
        <Settings2 size={13} /> Marketplace sources{custom ? ` (${registries().length})` : ""}
      </button>
    );
  return (
    <div class="plgm-box">
      <div class="plgm-box-h">
        <b>Marketplace sources</b>
        <button class="icon-btn" title="Close" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div class="muted small">One registry.json URL per line.</div>
      <textarea class="plg-code" rows={3} value={txt} onInput={(e) => setTxt((e.target as HTMLTextAreaElement).value)} />
      <div class="row">
        <button
          class="btn sm"
          disabled={!txt.split("\n").every((l) => !l.trim() || /^https?:\/\//.test(l.trim()))}
          onClick={() => {
            setRegistries(txt.split("\n"));
            setOpen(false);
            refreshMarket();
          }}
        >
          <Check size={13} /> Save
        </button>
        <button class="btn sm ghost" onClick={() => setTxt(DEFAULT_REGISTRY)}>
          Reset
        </button>
      </div>
    </div>
  );
}

/* ---------- detail window ---------- */
function Shots({ shots, base }: { shots: { src: string; caption?: string }[]; base: string }) {
  const [i, setI] = useState(0);
  const [big, setBig] = useState(false);
  if (!shots.length) return null;
  const n = shots.length;
  const s = shots[Math.min(i, n - 1)];
  const url = assetUrl(base, s.src);
  return (
    <div class="plgm-shots">
      <div class="plgm-shot">
        {url && <img src={url} alt={s.caption ?? `Screenshot ${i + 1}`} onClick={() => setBig(true)} title="Click to enlarge" />}
        {n > 1 && (
          <>
            <button class="plgm-nav l" title="Previous" onClick={() => setI((i + n - 1) % n)}>
              <ChevronLeft size={18} />
            </button>
            <button class="plgm-nav r" title="Next" onClick={() => setI((i + 1) % n)}>
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>
      {(s.caption || n > 1) && (
        <div class="plgm-shot-foot">
          <span class="muted small">{s.caption}</span>
          {n > 1 && (
            <span class="plgm-dots">
              {shots.map((_, k) => (
                <button key={k} class={k === i ? "on" : ""} title={`Screenshot ${k + 1}`} onClick={() => setI(k)} />
              ))}
            </span>
          )}
        </div>
      )}
      {big && url && (
        <div class="plgm-big" onClick={() => setBig(false)} title="Close">
          <img src={url} alt="" />
        </div>
      )}
    </div>
  );
}

function Detail() {
  const d = pluginDetail.value!;
  const all = views();
  const v = d.key ? all.find((x) => x.key === d.key) : all.find((x) => x.cfg?.id === d.id);
  const close = () => (pluginDetail.value = null);
  const m = v?.m;
  const base = v?.item?.base ?? v?.meta?.base ?? v?.cfg?.market?.base ?? "";
  const [desc, setDesc] = useState<string | null>(null);
  useEffect(() => {
    setDesc(null);
    if (!m) return;
    if (v?.meta?.description && !v.update) return setDesc(v.meta.description);
    description(m, base)
      .then(setDesc)
      .catch(() => setDesc(v?.meta?.description ?? m.summary ?? ""));
  }, [m?.id, m?.version, base]);
  const resolve: Resolver = useMemo(() => (url, kind) => (/^https?:\/\//i.test(url) ? url : kind === "img" && base ? assetUrl(base, url) : kind === "a" && /^mailto:/i.test(url) ? url : null), [base]);
  if (!v) {
    close();
    return null;
  }
  const cfg = v.cfg;
  const st = cfg ? pluginStatus.value[cfg.id] : undefined;
  const working = m ? busy.value[m.id] : undefined;
  const doInstall = () =>
    v.item &&
    install(v.item)
      .then(() => toast(`${v.name} ${v.update ? "updated" : "installed"}`))
      .catch((e) => toast(`${v.name}: ${e.message}`, "error", 7000));
  const shots = (m?.screenshots ?? []).map((s) => (typeof s === "string" ? { src: s } : s));
  const banner = m?.banner && base ? assetUrl(base, m.banner) : null;
  const src = v.item?.source === "repo" ? `https://github.com/${v.item.entry.repo}` : null;
  return (
    <CenterModal
      cls="plgm-detail"
      icon={<Icon src={v.icon} size={26} />}
      title={v.name}
      sub={[m?.author && `by ${m.author}`, m?.version && `v${m.version}`].filter(Boolean).join(" · ")}
      onClose={close}
    >
      <div class="plgm-d">
        {banner && <img class="plgm-banner" src={banner} alt="" />}
        <div class="plgm-d-head">
          <Icon src={v.icon} size={56} />
          <div class="plgm-d-title">
            <h3>{v.name}</h3>
            <div class="muted small">{v.summary}</div>
          </div>
          <div class="plgm-d-actions">
            {working ? (
              <button class="btn sm" disabled>
                <RefreshCw size={13} class="spin" /> {working}
              </button>
            ) : (
              <>
                {!cfg && v.item && m && (
                  <button class="btn sm" onClick={doInstall}>
                    <Download size={13} /> Install
                  </button>
                )}
                {cfg && v.update && (
                  <button class="btn sm" onClick={doInstall}>
                    <CircleArrowUp size={13} /> Update to v{m!.version}
                  </button>
                )}
                {cfg && (
                  <button class="btn sm ghost" onClick={() => setEnabled(cfg.id, !cfg.on)}>
                    {cfg.on ? "Disable" : "Enable"}
                  </button>
                )}
                {cfg && !cfg.market && (
                  <button class="btn sm ghost" title="Reload the code" onClick={() => reloadPlugin(cfg).catch((e) => toast(e.message, "error"))}>
                    <RefreshCw size={13} /> Reload
                  </button>
                )}
                {cfg && (
                  <button class="btn sm ghost danger" onClick={() => uninstall(cfg.id).then(close)}>
                    <Trash2 size={13} /> Uninstall
                  </button>
                )}
              </>
            )}
          </div>
        </div>
        {!cfg && v.item && (
          <div class="plg-warn">
            <AlertTriangle size={14} />
            <span>This plugin runs code inside the app with full access to it, your settings and the server. Install it only if you trust {m?.author ?? "its author"}.</span>
          </div>
        )}
        {st?.error && <div class="plgm-err">Error: {st.error}</div>}
        {v.error && <div class="plgm-err">{v.error}</div>}
        <div class="plgm-d-cols">
          <div class="plgm-d-main">
            <Shots shots={shots} base={base} />
            {desc == null ? <div class="muted small">Loading description…</div> : <Markdown src={desc} resolve={resolve} cls="plgm-md" />}
          </div>
          <aside class="plgm-d-side">
            <label class="lbl">Permissions</label>
            {m?.permissions?.length ? (
              <ul class="plgm-perms">
                {m.permissions.map((p) => (
                  <li key={p}>{PERMISSIONS[p] ?? p}</li>
                ))}
              </ul>
            ) : (
              <div class="muted small">None declared</div>
            )}
            <div class="muted small">Declared by the author — plugins aren't sandboxed.</div>
            <label class="lbl">Details</label>
            <dl class="plgm-dl">
              {m?.version && (
                <>
                  <dt>Version</dt>
                  <dd>
                    {m.version}
                    {cfg?.market && cfg.market.version !== m.version ? ` (installed ${cfg.market.version})` : ""}
                  </dd>
                </>
              )}
              {m?.minAppVersion && (
                <>
                  <dt>Needs app</dt>
                  <dd>{m.minAppVersion}+</dd>
                </>
              )}
              {m?.id && (
                <>
                  <dt>ID</dt>
                  <dd>{m.id}</dd>
                </>
              )}
              {cfg && !cfg.market && (
                <>
                  <dt>Source</dt>
                  <dd>{cfg.src.replace(/^(\w+):/, "$1 · ")}</dd>
                </>
              )}
              {v.item?.entry.sha256 && (
                <>
                  <dt>Checksum</dt>
                  <dd>Verified on install</dd>
                </>
              )}
            </dl>
            {m?.tags?.length ? (
              <div class="plgm-tags">
                {m.tags.map((t) => (
                  <span key={t} class="chip">
                    {t}
                  </span>
                ))}
              </div>
            ) : null}
            {src && (
              <a class="plgm-link" href={src} target="_blank" rel="noopener noreferrer">
                <GitFork size={13} /> {v.item!.entry.repo}
              </a>
            )}
            {m?.homepage && (
              <a class="plgm-link" href={m.homepage} target="_blank" rel="noopener noreferrer">
                <ExternalLink size={13} /> Homepage
              </a>
            )}
          </aside>
        </div>
      </div>
    </CenterModal>
  );
}
