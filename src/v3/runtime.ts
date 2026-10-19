import { ROUTE_PALETTE, RUN_SPEED_PX_S } from "./constants";
import { dist, pathLength } from "./geometry";
import { loadMapImage } from "./image";
import { loadStoredPreset } from "./presetStorage";
import { copyToClipboard, decodeShareState, encodeShareState } from "./share";
import type { Participant, PresetData, PresetMap, Route } from "./types";

interface RuntimeState {
  presetData: PresetData | null;
  routes: Route[];
  participants: Participant[];
  animate: boolean;
}

const state: RuntimeState = {
  presetData: null,
  routes: [],
  participants: [],
  animate: true,
};

let nextId = 1;
let dragFromIndex: number | null = null;
let isViewMode = false;
let editingId: number | null = null;
let editingOriginalName = "";

let img: HTMLImageElement;
let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

function buildRoutes(n: number): Route[] {
  const preset = state.presetData?.maps[`_${n}`];
  if (!preset || preset.paths.length !== n) return [];

  return preset.paths.map((p) => {
    const raw = p.points;
    if (raw.length < 2) return { points: raw.slice(), length: 0 };
    const pts = raw.concat([raw[0]]);
    return { points: pts, length: pathLength(pts) };
  });
}

function applyCount(n: number, names?: string[]): void {
  const current = state.participants;
  const next: Participant[] = [];
  for (let i = 0; i < n; i++) {
    const name = names?.[i] ?? current[i]?.name ?? "";
    const defaultLabel = current[i]?.defaultLabel ?? `Игрок ${i + 1}`;
    next.push({ id: nextId++, name, defaultLabel });
  }
  state.participants = next;
  editingId = null;

  const select = document.getElementById("quickCountSelect") as HTMLSelectElement;
  select.value = String(n);
}

function bindUI(): void {
  document.getElementById("quickCountSelect")!.addEventListener("change", (e) => {
    const n = parseInt((e.target as HTMLSelectElement).value, 10);
    if (isNaN(n)) return;
    applyCount(n);
    renderAll();
  });

  document.getElementById("clearBtn")!.addEventListener("click", () => {
    state.participants.forEach((p) => (p.name = ""));
    editingId = null;
    renderAll();
  });

  document.getElementById("shareLinkBtn")!.addEventListener("click", async () => {
    const hint = document.getElementById("shareLinkHint")!;
    if (!state.participants.length) {
      hint.textContent = "Сначала выбери число игроков";
      setTimeout(() => (hint.textContent = ""), 1800);
      return;
    }
    const presetForN = state.presetData?.maps[`_${state.participants.length}`];
    const preset: PresetMap | undefined = presetForN
      ? {
          paths: presetForN.paths.map((p) => ({
            points: p.points.map((pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) })),
          })),
        }
      : undefined;
    const encoded = await encodeShareState({
      n: state.participants.length,
      names: state.participants.map((p) => p.name),
      preset,
    });
    const url = `${location.origin}${location.pathname}?h=${encoded}#/`;
    const copied = await copyToClipboard(url);
    hint.textContent = copied ? "Ссылка скопирована" : "";
    if (copied) setTimeout(() => (hint.textContent = ""), 1800);
  });

  document.getElementById("animToggle")!.addEventListener("change", (e) => {
    state.animate = (e.target as HTMLInputElement).checked;
    drawScene(performance.now());
  });

  document.getElementById("debugToggle")?.addEventListener("change", renderDebug);

  document.addEventListener("pointerdown", (e) => {
    if (editingId === null) return;
    const target = e.target as HTMLElement;
    if (target.closest(".participant-name-input") || target.closest(".edit-btn")) return;
    finishEditing();
  });
}

function renderAll(): void {
  state.routes = buildRoutes(state.participants.length);
  renderList();
  renderEmptyHint();
  renderDebug();
  drawScene(performance.now());
}

function renderEmptyHint(): void {
  const hint = document.getElementById("emptyHint")!;
  hint.style.display = !isViewMode && state.participants.length === 0 ? "block" : "none";
}

function commitOrRevertEditing(id: number): void {
  const p = state.participants.find((x) => x.id === id);
  if (p && p.name.trim() === "") p.name = editingOriginalName;
}

function startEditing(p: Participant): void {
  if (editingId !== null && editingId !== p.id) {
    commitOrRevertEditing(editingId);
  }
  editingId = p.id;
  editingOriginalName = p.name;
  renderList();
  renderDebug();
  drawScene(performance.now());
}

function finishEditing(): void {
  if (editingId === null) return;
  commitOrRevertEditing(editingId);
  editingId = null;
  editingOriginalName = "";
  renderList();
  renderDebug();
  drawScene(performance.now());
}

function renderList(): void {
  const list = document.getElementById("participantList")!;
  const anyActive = editingId !== null || dragFromIndex !== null;
  list.classList.toggle("dim-others", anyActive);
  list.innerHTML = "";

  state.participants.forEach((p, idx) => {
    const li = document.createElement("li");
    const isEditing = !isViewMode && editingId === p.id;
    const isDraggingThis = dragFromIndex !== null && dragFromIndex === idx;
    li.className = "participant-row" + (isEditing || isDraggingThis ? " active-row" : "");
    li.dataset.idx = String(idx);

    const color = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
    const fallbackLabel = p.defaultLabel;

    li.innerHTML = `
      ${isViewMode ? "" : '<span class="handle">⋮⋮</span>'}
      <span class="route-badge" style="background:${color}">${idx + 1}</span>
      ${
        isEditing
          ? `<input class="participant-name-input" type="text" maxlength="24" placeholder="${escapeHtml(fallbackLabel.toLowerCase())}" value="${escapeHtml(p.name)}" />`
          : `<span class="participant-name">${escapeHtml(p.name || fallbackLabel)}</span>`
      }
      ${
        isViewMode
          ? ""
          : `<button class="edit-btn" aria-label="${isEditing ? "Готово" : "Редактировать имя"}">${isEditing ? "✕" : "✎"}</button>`
      }
    `;

    if (!isViewMode) {
      const editBtn = li.querySelector(".edit-btn")!;
      if (isEditing) {
        const input = li.querySelector<HTMLInputElement>(".participant-name-input")!;
        input.addEventListener("input", () => {
          p.name = input.value;
          renderDebug();
          drawScene(performance.now());
        });
        input.addEventListener("keydown", (e) => {
          if (e.key === "Enter") finishEditing();
        });
        editBtn.addEventListener("click", () => finishEditing());
        queueMicrotask(() => input.focus());
      } else {
        editBtn.addEventListener("click", () => startEditing(p));
      }
    }

    if (!isViewMode) {
      const handle = li.querySelector<HTMLSpanElement>(".handle")!;

      handle.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        dragFromIndex = idx;
        list.classList.add("dim-others");
        li.classList.add("dragging", "active-row");
        drawScene(performance.now());

        const onMove = (e: PointerEvent) => {
          if (dragFromIndex === null) return;
          const rows = Array.from(list.querySelectorAll<HTMLLIElement>(".participant-row"));
          const hovered = rows.find((row) => {
            const rect = row.getBoundingClientRect();
            return e.clientY >= rect.top && e.clientY <= rect.bottom;
          });
          if (!hovered) return;
          const toIdx = Number(hovered.dataset.idx);
          if (toIdx !== dragFromIndex) {
            const arr = state.participants;
            [arr[dragFromIndex], arr[toIdx]] = [arr[toIdx], arr[dragFromIndex]];
            dragFromIndex = toIdx;
            renderList();
            drawScene(performance.now());
            const newRow = list.querySelector(`[data-idx="${toIdx}"]`);
            newRow?.classList.add("dragging");
          }
        };

        const onUp = () => {
          dragFromIndex = null;
          renderList();
          drawScene(performance.now());
          document.removeEventListener("pointermove", onMove);
          document.removeEventListener("pointerup", onUp);
          document.removeEventListener("pointercancel", onUp);
        };

        document.addEventListener("pointermove", onMove);
        document.addEventListener("pointerup", onUp);
        document.addEventListener("pointercancel", onUp);
      });
    }

    list.appendChild(li);
  });
}

function escapeHtml(str: string): string {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderDebug(): void {
  const pre = document.getElementById("debugOutput");
  if (!pre) return;
  const on = (document.getElementById("debugToggle") as HTMLInputElement | null)?.checked ?? false;
  pre.style.display = on ? "block" : "none";
  if (!on) return;

  if (!state.routes.length) {
    pre.textContent = "Нет участников или нет пресета для текущего числа участников.";
    return;
  }

  const lines = state.routes.map((route, idx) => {
    const name = state.participants[idx]?.name || "(без имени)";
    const pts = route.points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" ");
    return `#${idx + 1} ${name} — ${route.points.length} точек, ${Math.round(route.length)}px\n  ${pts}`;
  });

  pre.textContent = lines.join("\n\n");
}

function pointAtDistance(points: Route["points"], cum: number[], d: number) {
  if (d <= 0) return points[0];
  const total = cum[cum.length - 1];
  if (d >= total) return points[points.length - 1];
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] >= d) {
      const segLen = cum[i] - cum[i - 1];
      const t = segLen === 0 ? 0 : (d - cum[i - 1]) / segLen;
      const a = points[i - 1];
      const b = points[i];
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return points[points.length - 1];
}

function cumulative(points: Route["points"]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return cum;
}

function drawScene(now: number): void {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const activeIdx =
    dragFromIndex !== null
      ? dragFromIndex
      : editingId !== null
        ? state.participants.findIndex((p) => p.id === editingId)
        : -1;
  const dimOthers = activeIdx !== -1;

  state.routes.forEach((route, idx) => {
    const color = ROUTE_PALETTE[idx % ROUTE_PALETTE.length];
    if (route.points.length < 2) return;

    ctx.save();
    ctx.globalAlpha = dimOthers && idx !== activeIdx ? 0.25 : 1;
    ctx.strokeStyle = color;
    ctx.lineWidth = 3.5;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.shadowColor = "rgba(0,0,0,0.65)";
    ctx.shadowBlur = 3;
    ctx.beginPath();
    ctx.moveTo(route.points[0].x, route.points[0].y);
    for (let i = 1; i < route.points.length; i++) {
      ctx.lineTo(route.points[i].x, route.points[i].y);
    }
    ctx.stroke();

    const start = route.points[0];
    drawBadge(start.x, start.y, color, String(idx + 1));

    if (state.animate) {
      const cum = cumulative(route.points);
      const total = cum[cum.length - 1];
      if (total > 0) {
        const phase = (idx / Math.max(1, state.routes.length)) * total;
        const t = ((now / 1000) * RUN_SPEED_PX_S + phase) % total;
        const pos = pointAtDistance(route.points, cum, t);
        drawRunner(pos.x, pos.y, color);
        const participant = state.participants[idx];
        const name = participant ? participant.name || participant.defaultLabel : `Игрок ${idx + 1}`;
        drawNameLabel(pos.x, pos.y, name, color);
      }
    }

    ctx.restore();
  });
}

function drawBadge(x: number, y: number, color: string, label: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 9, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "rgba(0,0,0,0.6)";
  ctx.stroke();
  ctx.fillStyle = "#0e0f14";
  ctx.font = "bold 10px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x, y + 0.5);
  ctx.restore();
}

function drawRunner(x: number, y: number, color: string): void {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 5, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

function drawNameLabel(x: number, y: number, name: string, color: string): void {
  ctx.save();
  ctx.font = "bold 11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.strokeText(name, x, y - 9);
  ctx.fillStyle = color;
  ctx.fillText(name, x, y - 9);
  ctx.restore();
}

function tick(now: number): void {
  if (state.animate && state.routes.length) {
    drawScene(now);
  }
  requestAnimationFrame(tick);
}

export async function mountRuntime(): Promise<void> {
  canvas = document.getElementById("mapCanvas") as HTMLCanvasElement;
  ctx = canvas.getContext("2d")!;

  const h = new URLSearchParams(location.search).get("h");
  const shared = h ? await decodeShareState(h) : null;
  const sharedPreset: PresetData | null = shared?.preset
    ? { maps: { [`_${shared.n}`]: shared.preset } }
    : null;

  const stored = sharedPreset ? null : loadStoredPreset();

  const [loadedImg, presetData] = await Promise.all([
    loadMapImage(),
    sharedPreset
      ? Promise.resolve(sharedPreset)
      : stored
        ? Promise.resolve(stored)
        : fetch(`preset.json`)
            .then((r) => r.json() as Promise<PresetData>)
            .catch(() => ({ maps: {} }) as PresetData),
  ]);

  img = loadedImg;
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  state.presetData = presetData;

  if (shared) {
    isViewMode = true;
    document.body.classList.add("view-mode");
    applyCount(shared.n, shared.names);
  }

  bindUI();
  renderAll();
  requestAnimationFrame(tick);
}
