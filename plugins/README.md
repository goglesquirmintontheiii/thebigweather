# Plugin marketplace

This folder is the app's plugin marketplace. The **Plugins** tab in the app's sidebar reads
[`registry.json`](registry.json) from here (on the `main` branch, through
`raw.githubusercontent.com`) and lists every plugin in it.

> Plugins are JavaScript that runs inside the app with the same rights as the app. Only list
> plugins you wrote or have read.

## Add a plugin from this repo (folder)

1. Make a folder `plugins/<id>/` (lowercase letters, digits, `-`). Copy one of the examples
   (`storm-eta-chime/`, `hail-legend/`) as a starting point.
2. Put in it:
   - `plugin.json` — the manifest (below)
   - `main.js` — the plugin code (one file, see [docs/PLUGINS.md](../docs/PLUGINS.md) for the `tbw` / `stormiq` API)
   - `README.md` — the description shown in the app (markdown)
   - `icon.png` (square, 256×256), `banner.png` (4:1, e.g. 1200×300), `screenshots/*.png` (16:9)
3. Run `node tools/plugins-registry.mjs`. It checks the manifest and files and rewrites
   `registry.json` with the new plugin and its checksums.
4. Commit and push to `main`. The plugin shows up in everyone's Marketplace tab (press ↻ to refresh).

To release an update: change the code, bump `version` in `plugin.json`, run the tool again, push.
Installed copies show an **Update** badge.

## Add a plugin from another GitHub repo

The repo needs a `plugin.json` (and the files it names) at its root or in a sub-folder. Then:

```sh
node tools/plugins-registry.mjs --add-repo owner/name             # repo root, branch main
node tools/plugins-registry.mjs --add-repo owner/name@v1.2:plugin # tag v1.2, folder plugin/
node tools/plugins-registry.mjs --remote                          # optional: download and check it
```

or add an entry by hand to `registry.json`:

```json
{ "repo": "owner/name", "ref": "main", "path": "." }
```

The app reads `https://raw.githubusercontent.com/<repo>/<ref>/<path>/plugin.json`.
If `ref` is a full commit hash, `--remote` also pins checksums, so the files can't change under you.

## plugin.json

```json
{
  "id": "storm-eta-chime",
  "name": "Storm ETA chime",
  "version": "1.0.0",
  "author": "Your name",
  "summary": "One line for the card.",
  "description": "README.md",
  "icon": "icon.png",
  "banner": "banner.png",
  "screenshots": ["screenshots/one.png", { "src": "screenshots/two.png", "caption": "Optional caption" }],
  "entry": "main.js",
  "permissions": ["server", "settings", "audio", "panel"],
  "minAppVersion": "0.8.2",
  "homepage": "https://github.com/you/your-plugin",
  "tags": ["alerts"]
}
```

| Field | |
| --- | --- |
| `id`, `name`, `version`, `entry` | Required. `entry` is one `.js` file (ES module with `export default function (tbw) {…}`, or a plain script). |
| `description` | A markdown file in the folder (`README.md`) or inline markdown. Supports headings, **bold**, *italic*, `code`, lists, tables, quotes, links and images (files in the folder or https). Raw HTML is shown as text. |
| `icon`, `banner`, `screenshots` | Files in the plugin folder (PNG / JPEG / WebP). |
| `permissions` | What the plugin uses, shown before install: `map`, `panel`, `alerts`, `server`, `settings`, `audio`, `network`, `notifications`. Informational — plugins aren't sandboxed. |
| `minAppVersion` | The app refuses to install on older versions. |

Inside the plugin, `tbw.plugin.base` is the plugin folder's URL and `tbw.asset("sound.mp3")` gives the
URL of a file in it.

## Using other registries

In the app: Plugins → Marketplace → **Marketplace sources** — one `registry.json` URL per line
(for example your fork's `https://raw.githubusercontent.com/<you>/<repo>/main/plugins/registry.json`).
