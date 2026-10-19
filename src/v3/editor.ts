import { ROUTE_PALETTE } from "./constants";
import { loadMapImage } from "./image";
import { loadStoredPreset, saveStoredPreset } from "./presetStorage";
import type { Point, PresetData, PresetMap } from "./types";

interface EditorState {
  activeN: number;
  activePlayerIdx: number;
  maps: Record<string, PresetMap>;
}

const editorState: EditorState = {
  activeN: 4,
  activePlayerIdx: 0,
  maps: {},
};

const HIT_RADIUS = 10;
const EDGE_HIT_RADIUS = 8;
const DBLCLICK_WINDOW_MS = 240;
const MIN_N = 4;
const MAX_N = 12;

let img: HTMLImageElement;
let editorCanvas: HTMLCanvasElement;
let editorCtx: CanvasRenderingContext2D;

function emptyMaps(): Record<string, PresetMap> {
  const maps: Record<string, PresetMap> = {};
  for (let n = MIN_N; n <= MAX_N; n++) {
    maps[`_${n}`] = { paths: Array.from({ length: n }, () => ({ points: [] })) };
  }
  return maps;
}

function normalizeMaps(raw: PresetData | null): Record<string, PresetMap> {
  const maps = emptyMaps();
  if (raw?.maps) {
    for (let n = MIN_N; n <= MAX_N; n++) {
      const key = `_${n}`;
      const src = raw.maps[key];
      if (src && Array.isArray(src.paths)) {
        for (let i = 0; i < n; i++) {
          const srcPath = src.paths[i];
          maps[key].paths[i] = {
            points: srcPath && Array.isArray(srcPath.points) ? srcPath.points.slice() : [],
          };
        }
      }
    }
  }
  return maps;
}

async function fetchBundledPreset(): Promise<PresetData | null> {
  try {
    const r = await fetch(`preset.json`);
    return (await r.json()) as PresetData;
  } catch {
    return null;
  }
}

async function loadEditor(): Promise<void> {
  const stored = loadStoredPreset();
  editorState.maps = normalizeMaps(stored ?? (await fetchBundledPreset()));
  initEditorUI();
}

function initEditorUI(): void {
  renderTabs();
  bindEditorButtons();
  bindEditorCanvas();
  selectTab(MIN_N);
}

function renderTabs(): void {
  const wrap = document.getElementById("editorTabs")!;
  wrap.innerHTML = "";
  for (let n = MIN_N; n <= MAX_N; n++) {
    const btn = document.createElement("button");
    btn.className = "editor-tab" + (n === editorState.activeN ? " active" : "");
    btn.textContent = String(n);
    btn.addEventListener("click", () => selectTab(n));
    wrap.appendChild(btn);
  }
}

function selectTab(n: number): void {
  editorState.activeN = n;
  editorState.activePlayerIdx = 0;
  selectedPointIdx = null;
  renderTabs();
  renderPlayers();
  drawEditorScene();
  updateJsonOutput();
}

function activePaths() {
  return editorState.maps[`_${editorState.activeN}`].paths;
}

function activePath() {
  return activePaths()[editorState.activePlayerIdx];
}

function renderPlayers(): void {
  const wrap = document.getElementById("editorPlayers")!;
  wrap.innerHTML = "";
  activePaths().forEach((path, idx) => {
    const color = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
    const row = document.createElement("div");
    row.className = "editor-player-row" + (idx === editorState.activePlayerIdx ? " active" : "");

    const badge = document.createElement("span");
    badge.className = "route-badge";
    badge.style.background = color;
    badge.textContent = String(idx + 1);

    const info = document.createElement("span");
    info.className = "editor-player-info";
    info.textContent = `${path.points.length} точек`;

    row.append(badge, info);
    row.addEventListener("click", () => {
      editorState.activePlayerIdx = idx;
      selectedPointIdx = null;
      renderPlayers();
      drawEditorScene();
    });
    wrap.appendChild(row);
  });
}

function bindEditorButtons(): void {
  document.getElementById("copyPresetBtn")?.addEventListener("click", () => {
    const text = document.getElementById("presetOutput")!.textContent ?? "";
    const hint = document.getElementById("editorCopyHint")!;
    const done = () => {
      hint.textContent = "Скопировано";
      setTimeout(() => (hint.textContent = ""), 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(done, () => prompt("Скопируй вручную:", text));
    } else {
      prompt("Скопируй вручную:", text);
    }
  });

  document.getElementById("savePresetBtn")!.addEventListener("click", () => {
    const hint = document.getElementById("editorSaveHint")!;
    const ok = saveStoredPreset({ maps: editorState.maps });
    hint.textContent = ok ? "Сохранено" : "Не удалось сохранить";
    setTimeout(() => (hint.textContent = ""), 1500);
  });

  document.getElementById("clearPathBtn")!.addEventListener("click", () => {
    activePath().points = [];
    selectedPointIdx = null;
    renderPlayers();
    drawEditorScene();
    updateJsonOutput();
  });

  document.getElementById("resetPresetBtn")!.addEventListener("click", async () => {
    if (!confirm("Сбросить все несохранённые правки и перечитать preset.json?")) return;
    editorState.maps = normalizeMaps(await fetchBundledPreset());
    selectTab(editorState.activeN);
  });
}

function getEditorPoint(evt: PointerEvent | MouseEvent): Point {
  const rect = editorCanvas.getBoundingClientRect();
  const scaleX = editorCanvas.width / rect.width;
  const scaleY = editorCanvas.height / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

function distPt(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return distPt(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return distPt(p, { x: a.x + t * dx, y: a.y + t * dy });
}

function findPointNear(points: Point[], p: Point): number {
  for (let i = 0; i < points.length; i++) {
    if (distPt(points[i], p) <= HIT_RADIUS) return i;
  }
  return -1;
}

function findSegmentNear(points: Point[], p: Point): number {
  if (points.length < 2) return -1;
  let best = -1;
  let bestDist = EDGE_HIT_RADIUS;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const d = distToSegment(p, a, b);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

interface DragInfo {
  idx: number;
  pointerId: number;
  moved: boolean;
}

let dragInfo: DragInfo | null = null;
let pendingAppend: { timeoutId: number } | null = null;
let selectedPointIdx: number | null = null;

function bindEditorCanvas(): void {
  editorCanvas.style.touchAction = "none";

  editorCanvas.addEventListener("pointerdown", (e) => {
    const p = getEditorPoint(e);
    const path = activePath();
    const idx = findPointNear(path.points, p);
    selectedPointIdx = idx >= 0 ? idx : null;
    if (idx >= 0) {
      dragInfo = { idx, pointerId: e.pointerId, moved: false };
      editorCanvas.setPointerCapture(e.pointerId);
    }
    drawEditorScene();
  });

  editorCanvas.addEventListener("pointermove", (e) => {
    if (!dragInfo) return;
    const p = getEditorPoint(e);
    dragInfo.moved = true;
    activePath().points[dragInfo.idx] = p;
    drawEditorScene();
  });

  editorCanvas.addEventListener("pointerup", (e) => {
    if (dragInfo) {
      dragInfo = null;
      renderPlayers();
      drawEditorScene();
      updateJsonOutput();
      return;
    }

    const p = getEditorPoint(e);
    if (pendingAppend) {
      clearTimeout(pendingAppend.timeoutId);
      pendingAppend = null;
    }
    const timeoutId = window.setTimeout(() => {
      pendingAppend = null;
      const path = activePath();
      path.points.push(p);
      selectedPointIdx = path.points.length - 1;
      renderPlayers();
      drawEditorScene();
      updateJsonOutput();
    }, DBLCLICK_WINDOW_MS);
    pendingAppend = { timeoutId };
  });

  editorCanvas.addEventListener("dblclick", (e) => {
    if (pendingAppend) {
      clearTimeout(pendingAppend.timeoutId);
      pendingAppend = null;
    }
    const p = getEditorPoint(e);
    const path = activePath();
    const pointIdx = findPointNear(path.points, p);
    if (pointIdx >= 0) {
      path.points.splice(pointIdx, 1);
    } else {
      const segIdx = findSegmentNear(path.points, p);
      if (segIdx >= 0) {
        path.points.splice(segIdx + 1, 0, p);
      }
    }
    selectedPointIdx = null;
    renderPlayers();
    drawEditorScene();
    updateJsonOutput();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Backspace" && e.key !== "Delete") return;
    if (selectedPointIdx === null) return;
    e.preventDefault();
    const path = activePath();
    if (selectedPointIdx >= path.points.length) {
      selectedPointIdx = null;
      return;
    }
    path.points.splice(selectedPointIdx, 1);
    selectedPointIdx = null;
    renderPlayers();
    drawEditorScene();
    updateJsonOutput();
  });
}

function drawEditorScene(): void {
  editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  editorCtx.drawImage(img, 0, 0, editorCanvas.width, editorCanvas.height);

  activePaths().forEach((path, idx) => {
    const color = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
    const isActive = idx === editorState.activePlayerIdx;
    if (path.points.length < 2) {
      if (path.points.length === 1 && isActive) drawPointHandle(path.points[0], color, true, selectedPointIdx === 0);
      return;
    }

    editorCtx.save();
    editorCtx.strokeStyle = color;
    editorCtx.lineWidth = isActive ? 3 : 1.5;
    editorCtx.globalAlpha = isActive ? 1 : 0.45;
    editorCtx.lineJoin = "round";
    editorCtx.lineCap = "round";
    editorCtx.beginPath();
    editorCtx.moveTo(path.points[0].x, path.points[0].y);
    for (let i = 1; i < path.points.length; i++) {
      editorCtx.lineTo(path.points[i].x, path.points[i].y);
    }
    editorCtx.closePath();
    editorCtx.stroke();
    editorCtx.restore();

    if (isActive) {
      path.points.forEach((pt, i) => drawPointHandle(pt, color, i === 0, i === selectedPointIdx));
    }
  });
}

function drawPointHandle(pt: Point, color: string, isFirst: boolean, isSelected: boolean): void {
  const r = isFirst ? 7 : 5;

  if (isSelected) {
    editorCtx.save();
    editorCtx.beginPath();
    editorCtx.setLineDash([3, 3]);
    editorCtx.arc(pt.x, pt.y, r + 5, 0, Math.PI * 2);
    editorCtx.lineWidth = 2;
    editorCtx.strokeStyle = "#ffffff";
    editorCtx.stroke();
    editorCtx.restore();
  }

  editorCtx.save();
  editorCtx.beginPath();
  editorCtx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
  editorCtx.fillStyle = color;
  editorCtx.fill();
  editorCtx.lineWidth = isSelected ? 2.5 : 1.5;
  editorCtx.strokeStyle = isSelected ? "#ffffff" : "rgba(0,0,0,0.7)";
  editorCtx.stroke();
  editorCtx.restore();
}

function updateJsonOutput(): void {
  const rounded: Record<string, PresetMap> = {};
  for (const key of Object.keys(editorState.maps)) {
    rounded[key] = {
      paths: editorState.maps[key].paths.map((p) => ({
        points: p.points.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) })),
      })),
    };
  }
  const pre = document.getElementById("presetOutput");
  if (pre) pre.textContent = JSON.stringify({ maps: rounded }, null, 2);
}

export async function mountEditor(): Promise<void> {
  editorCanvas = document.getElementById("editorCanvas") as HTMLCanvasElement;
  editorCtx = editorCanvas.getContext("2d")!;
  img = await loadMapImage();
  await loadEditor();
}
