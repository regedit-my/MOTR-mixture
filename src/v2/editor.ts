import { ROUTE_PALETTE } from "./constants";
import { loadMapImage } from "./image";
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

const EDITOR_STORAGE_KEY = "motr_editor_maps_v1";
const HIT_RADIUS = 10; // px в координатах канвы (512x512)
const EDGE_HIT_RADIUS = 8;
const DBLCLICK_WINDOW_MS = 240; // пауза перед "добавить точку", чтобы успеть поймать dblclick
const MIN_N = 4;
const MAX_N = 12;

let img: HTMLImageElement;
let editorCanvas: HTMLCanvasElement;
let editorCtx: CanvasRenderingContext2D;

/* ---------- загрузка/нормализация данных ---------- */

function emptyMaps(): Record<string, PresetMap> {
  const maps: Record<string, PresetMap> = {};
  for (let n = MIN_N; n <= MAX_N; n++) {
    maps[`_${n}`] = { paths: Array.from({ length: n }, () => ({ points: [] })) };
  }
  return maps;
}

// Гарантирует, что у каждого _4.._12 ровно N путей (на случай, если в preset.json
// чего-то не хватает или структура повреждена) — дополняет/обрезает, не трогая
// уже существующие точки.
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


async function fetchPreset(): Promise<PresetData | null> {
  try {
    const r = await fetch(`/v2/preset.json`);
    return (await r.json()) as PresetData;
  } catch {
    return null;
  }
}

async function loadEditor(): Promise<void> {
  let fromStorage: PresetData | null = null;
  try {
    const raw = localStorage.getItem(EDITOR_STORAGE_KEY);
    if (raw) fromStorage = JSON.parse(raw) as PresetData;
  } catch {
    fromStorage = null;
  }

  editorState.maps = normalizeMaps(fromStorage ?? (await fetchPreset()));
  initEditorUI();
}

function saveToStorage(): void {
  try {
    localStorage.setItem(EDITOR_STORAGE_KEY, JSON.stringify({ maps: editorState.maps }));
  } catch {
    /* ignore */
  }
}

/* ---------- инициализация UI ---------- */

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
      renderPlayers();
      drawEditorScene();
    });
    wrap.appendChild(row);
  });
}

function bindEditorButtons(): void {
  document.getElementById("copyPresetBtn")!.addEventListener("click", () => {
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

  document.getElementById("clearPathBtn")!.addEventListener("click", () => {
    activePath().points = [];
    saveToStorage();
    renderPlayers();
    drawEditorScene();
    updateJsonOutput();
  });

  document.getElementById("resetPresetBtn")!.addEventListener("click", async () => {
    if (!confirm("Сбросить все несохранённые правки и перечитать preset.json?")) return;
    localStorage.removeItem(EDITOR_STORAGE_KEY);
    editorState.maps = normalizeMaps(await fetchPreset());
    selectTab(editorState.activeN);
  });
}

/* ---------- геометрия ---------- */

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

// Возвращает индекс сегмента (i), к которому ближе всего точка p, если это
// достаточно близко — новую точку нужно вставить ПОСЛЕ points[i].
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

/* ---------- взаимодействие с канвой ---------- */

interface DragInfo {
  idx: number;
  pointerId: number;
  moved: boolean;
}

let dragInfo: DragInfo | null = null;
let pendingAppend: { timeoutId: number } | null = null;

function bindEditorCanvas(): void {
  editorCanvas.style.touchAction = "none";

  editorCanvas.addEventListener("pointerdown", (e) => {
    const p = getEditorPoint(e);
    const path = activePath();
    const idx = findPointNear(path.points, p);
    if (idx >= 0) {
      dragInfo = { idx, pointerId: e.pointerId, moved: false };
      editorCanvas.setPointerCapture(e.pointerId);
    }
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
      saveToStorage();
      renderPlayers();
      drawEditorScene();
      updateJsonOutput();
      return;
    }

    // Обычный клик по пустому месту (не по точке) — запланировать добавление
    // точки в конец пути, но дать шанс dblclick его отменить.
    const p = getEditorPoint(e);
    if (pendingAppend) {
      clearTimeout(pendingAppend.timeoutId);
      pendingAppend = null;
    }
    const timeoutId = window.setTimeout(() => {
      pendingAppend = null;
      activePath().points.push(p);
      saveToStorage();
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
    saveToStorage();
    renderPlayers();
    drawEditorScene();
    updateJsonOutput();
  });
}

/* ---------- отрисовка ---------- */

function drawEditorScene(): void {
  editorCtx.clearRect(0, 0, editorCanvas.width, editorCanvas.height);
  editorCtx.drawImage(img, 0, 0, editorCanvas.width, editorCanvas.height);

  activePaths().forEach((path, idx) => {
    const color = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
    const isActive = idx === editorState.activePlayerIdx;
    if (path.points.length < 2) {
      if (path.points.length === 1 && isActive) drawPointHandle(path.points[0], color, true);
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
    editorCtx.closePath(); // путь всегда замкнутый контур
    editorCtx.stroke();
    editorCtx.restore();

    if (isActive) {
      path.points.forEach((pt, i) => drawPointHandle(pt, color, i === 0));
    }
  });
}

function drawPointHandle(pt: Point, color: string, isFirst: boolean): void {
  editorCtx.save();
  editorCtx.beginPath();
  editorCtx.arc(pt.x, pt.y, isFirst ? 7 : 5, 0, Math.PI * 2);
  editorCtx.fillStyle = color;
  editorCtx.fill();
  editorCtx.lineWidth = 1.5;
  editorCtx.strokeStyle = "rgba(0,0,0,0.7)";
  editorCtx.stroke();
  editorCtx.restore();
}

/* ---------- JSON-превью ---------- */

function updateJsonOutput(): void {
  const rounded: Record<string, PresetMap> = {};
  for (const key of Object.keys(editorState.maps)) {
    rounded[key] = {
      paths: editorState.maps[key].paths.map((p) => ({
        points: p.points.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) })),
      })),
    };
  }
  document.getElementById("presetOutput")!.textContent = JSON.stringify({ maps: rounded }, null, 2);
}

/* ---------- монтирование ---------- */

export async function mountEditor(): Promise<void> {
  editorCanvas = document.getElementById("editorCanvas") as HTMLCanvasElement;
  editorCtx = editorCanvas.getContext("2d")!;
  img = await loadMapImage();
  await loadEditor();
}
