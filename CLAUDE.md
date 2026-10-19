# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm run dev` — start Vite dev server (serves `index.html`, `v1/`, `v2/`, `v3/` with live reload)
- `npm run build` — type-check (`tsc -b`) then production build into `dist/`
- `npm run preview` — serve the built `dist/` locally

There is no lint config, no test runner, and no CI step beyond build+deploy (`.github/workflows/deploy.yml` builds and pushes `dist/` to GitHub Pages on push to `master`). There is no single-test command because there are no tests.

## Architecture

This is a small static site, not an SPA — it's independent pages built via Vite's multi-page config (`vite.config.ts`), all emitted flat into `dist/`:

- `index.html` — a plain landing page linking to v1, v2, and v3 (no JS logic).
- `v1/` — algorithmic version. Pure JS, no TypeScript, no build-time imports: `v1/app.js` is loaded directly as a module script from `v1/index.html`.
- `v2/` — preset-based version (the "actual"/stable one per the landing page copy — **do not modify**, it's kept working as a reference/fallback). TypeScript, under `src/v2/`, two entry points: `v2/index.html` (runtime/viewer) → `src/v2/main-runtime.ts`, and `v2/editor.html` (route editor, dev-only in v2) → `src/v2/main-editor.ts`.
- `v3/` — fork of v2 that opens the preset editor to every user (not just dev builds) and lets them persist their own routes to `localStorage`. TypeScript, under `src/v3/`, same two-entry-point shape as v2 (`v3/index.html` → `src/v3/main-runtime.ts`, `v3/editor.html` → `src/v3/main-editor.ts`).

The app's purpose: split a party of N players (4–12) across non-overlapping routes through a fixed dungeon map image, assign each player a colored route, and animate a runner looping along it.

### v1 vs v2 — two different strategies for the same problem

- **v1** computes routes at runtime from the map image itself: threshold the image into a floor/wall grid (`buildFloorGrid`), keep the largest connected region (`largestComponent`), skeletonize it (`zhangSuenThin`), build a spanning tree of the skeleton (`buildSpanningTree`), split that tree into N non-overlapping pieces (`splitTreeIntoPieces`) and build a closed tour per piece (`buildTourFromRoot`), then simplify the result with line-of-sight shortcutting (`simplifyWithLineOfSight`). This is all in one file, `v1/app.js`, executed top-to-bottom per render.
- **v2** does none of this — routes are pre-drawn once in the editor and shipped as static data in `public/v2/preset.json` (shape: `{ maps: { "_4": { paths: [...] }, "_5": ..., ..., "_12": {...} } }`, one entry per supported player count, each path a list of `{x,y}` points in the 512×512 map image's coordinate space). The runtime (`src/v2/runtime.ts`) just looks up `preset.json["_" + n]` and draws it — `buildRoutes` in v2 does no pathfinding, it only closes the loop and computes length.

When changing v2 route data, you edit it via the editor UI (`v2/editor.html`), not by hand-writing JSON — `src/v2/editor.ts` is the source of truth for the preset format and point-editing interactions (drag point, double-click to delete/insert, per-player-count tabs from `MIN_N`–`MAX_N`).

### v2 module layout (`src/v2/`)

- `types.ts` — shared shapes (`Point`, `PresetData`, `Route`, `Participant`).
- `constants.ts` — route color palette and runner animation speed.
- `geometry.ts` — `dist`/`pathLength` helpers shared by runtime and editor.
- `image.ts` — loads and caches the single dungeon map `HTMLImageElement`, shared between runtime and editor; resolves to a different path in dev vs. the built site (see comment in the file) because of where `public/` assets land relative to the HTML entry point.
- `share.ts` — encodes/decodes participant count + names into the `?h=` URL param (base64url of JSON) so a configured lineup can be shared as a link; recipients open in a read-only "view mode" (no drag/rename).
- `devMode.ts` — strips the dev-only nav bar (`#devNav`) and debug panel (`#debugSection`) from the DOM in production builds (checked via `import.meta.env.DEV`); these elements exist in both `v2/index.html` and `v2/editor.html`.
- `runtime.ts` — the viewer page: participant list (add/rename/reorder via drag), builds routes from the preset for the current N, renders the canvas loop (static routes + animated runner + name labels), handles the share-link flow and `?h=` view mode.
- `editor.ts` — the preset editor: per-N tabs, per-player path editing on canvas (click to append point, drag to move, dblclick to insert/delete), live JSON preview meant to be copied back into `public/v2/preset.json`.
- `main-runtime.ts` / `main-editor.ts` — thin entry points that import global CSS, call `applyDevVisibility()`, then mount the corresponding module.

Both v2 pages assume a 512×512 source map image (`public/v2/assets/dungeon.png`); canvas dimensions are set from the loaded image's natural size.

Code comments throughout `src/v2/` are in Russian and explain *why*, not *what* — worth reading before changing logic they annotate (e.g. why routes key off slot index rather than participant id, why empty names revert on blur, why the dev nav is removed rather than hidden).

### v3 — user-editable presets (`src/v3/`)

v3 is a near-byte-copy of v2 with three deliberate differences; when fixing a bug common to both, check whether it needs porting to both directories (there's no shared code between them by design — `v2` must keep working unmodified).

- `presetStorage.ts` (new file, no v2 equivalent) — reads/writes the user's custom preset as JSON under a **versioned** localStorage key, `` `motr:v3:preset:v${PRESET_STORAGE_VERSION}` ``. Bump `PRESET_STORAGE_VERSION` on any incompatible change to the `PresetData`/`PresetMap` shape so old, now-invalid localStorage entries are silently ignored rather than crashing something — there's no migration path yet (noted in the file as a deliberate "do this later if needed").
- `runtime.ts` and `editor.ts` both call `loadStoredPreset()` on mount and use it in place of fetching the bundled `preset.json` when it returns non-null — a saved custom preset takes priority over the shipped one, on both the viewer and the editor itself (so reopening the editor continues editing what you last saved, not the bundle).
- `devMode.ts` no longer removes the nav (`#mainNav`) in production — the editor tab is meant to be reachable by every user, not just in dev. It still strips the debug panel and, from the editor page, `#copyPresetBtn`/`#presetOutput` (the raw-JSON copy flow is only for whoever maintains the bundled `public/v3/preset.json`). The editor's "Сохранить" button (`savePresetBtn` → `saveStoredPreset`) is the production-facing save action and exists in both dev and prod.

Not yet solved (deliberately deferred, discussed but out of scope for the current implementation): sharing a custom preset with someone else via a link. The existing `?h=` share link only encodes participant count + names, not route geometry, so a link only reproduces someone else's *lineup* against whatever preset (bundled or their own localStorage one) is already loaded in the recipient's browser — it cannot yet transmit someone's custom routes to another browser.
