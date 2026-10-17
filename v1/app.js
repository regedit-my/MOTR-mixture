"use strict";

/* ---------- конфигурация ---------- */

const GRID_CELL = 4; // px на одну ячейку сетки (512 / 4 = 128x128)
const MIN_FLOOR_CELLS = 15; // отсечь шумовые island-пиксели
const MIN_LOOP_LENGTH = 50; // px; меньше — пиксельный шум скелетизации, не настоящее кольцо
const PROXIMITY_MAX_DIST = 40; // px; максимальное расстояние между "соседними по месту" точками
const PROXIMITY_MIN_RATIO = 2.5; // во сколько раз путь по дереву должен быть длиннее прямой, чтобы её стоило срезать

const FLOOR_RGB = [0, 0, 0];
const WALL_RGB = [171, 171, 171];

const ROUTE_PALETTE = [
  "#5b8cff", "#ff6b6b", "#ffd93d", "#6bcb77", "#c77dff",
  "#4ecdc4", "#ff9f1c", "#f72585", "#90e0ef", "#a0c4ff",
  "#ffafcc", "#bdb2ff", "#fcbf49", "#80ed99", "#ef476f", "#06d6a0",
];

const RUN_SPEED_PX_S = 70;

/* ---------- состояние ---------- */

const state = {
  gridSize: 0,
  masterData: null, // {tree, toPixel, subtreeWeight, totalWeight, cellSet, gridSize}
  routes: [], // текущие N маршрутов (непересекающиеся ветки дерева) под число участников
  participants: [], // [{id, name}]
  animate: true,
};

let nextId = 1;
let dragFromIndex = null;
let isViewMode = false;
let editingId = null;
let editingOriginalName = "";

/* ---------- загрузка и разбор картинки ---------- */

// В проде debug-панель убирается целиком (нужна только при разработке).
if (!import.meta.env.DEV) {
  document.getElementById("debugSection")?.remove();
}

const img = new Image();
img.src = "assets/dungeon.png";
img.onload = init;

const canvas = document.getElementById("mapCanvas");
const ctx = canvas.getContext("2d");

function init() {
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;

  const off = document.createElement("canvas");
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const offCtx = off.getContext("2d");
  offCtx.drawImage(img, 0, 0);
  const imageData = offCtx.getImageData(0, 0, off.width, off.height);

  const grid = buildFloorGrid(imageData, off.width, off.height);
  state.gridSize = Math.floor(off.width / GRID_CELL);
  state.masterData = buildMasterData(grid, state.gridSize);

  // Ссылка вида ?h=... — чужой готовый расклад открывается в режиме просмотра:
  // имена/порядок подставлены, но ничего в нём менять нельзя.
  const h = new URLSearchParams(location.search).get("h");
  const sharedNames = h ? decodeShareState(h) : null;
  if (sharedNames) {
    isViewMode = true;
    document.body.classList.add("view-mode");
    state.participants = sharedNames.map((name) => ({ id: nextId++, name }));
  }

  bindUI();
  renderAll();
  requestAnimationFrame(tick);
}

function colorDistance(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return dr * dr + dg * dg + db * db;
}

// Картинка теперь строго двухцветная (чёрный пол / серый стены) — классификация
// пикселя сводится к тому, какой из двух эталонов ближе.
function isFloorPixel(r, g, b) {
  return colorDistance([r, g, b], FLOOR_RGB) < colorDistance([r, g, b], WALL_RGB);
}

function buildFloorGrid(imageData, w, h) {
  const gridW = Math.floor(w / GRID_CELL);
  const gridH = Math.floor(h / GRID_CELL);
  const grid = new Uint8Array(gridW * gridH);
  const data = imageData.data;

  for (let gr = 0; gr < gridH; gr++) {
    for (let gc = 0; gc < gridW; gc++) {
      const px = gc * GRID_CELL + Math.floor(GRID_CELL / 2);
      const py = gr * GRID_CELL + Math.floor(GRID_CELL / 2);
      const off = (py * w + px) * 4;
      grid[gr * gridW + gc] = isFloorPixel(data[off], data[off + 1], data[off + 2]) ? 1 : 0;
    }
  }
  return grid;
}

/* ---------- построение полного маршрута по всему подземелью ---------- */

function largestComponent(grid, gridSize) {
  const visited = new Uint8Array(gridSize * gridSize);
  let best = null;
  let bestSize = 0;

  for (let i = 0; i < grid.length; i++) {
    if (!grid[i] || visited[i]) continue;
    const stack = [i];
    visited[i] = 1;
    const cells = [];
    while (stack.length) {
      const cur = stack.pop();
      cells.push(cur);
      const r = Math.floor(cur / gridSize);
      const c = cur % gridSize;
      const neighbors = [
        r > 0 ? cur - gridSize : -1,
        r < gridSize - 1 ? cur + gridSize : -1,
        c > 0 ? cur - 1 : -1,
        c < gridSize - 1 ? cur + 1 : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && grid[n]) {
          visited[n] = 1;
          stack.push(n);
        }
      }
    }
    if (cells.length > bestSize) {
      bestSize = cells.length;
      best = cells;
    }
  }
  if (!best || bestSize < MIN_FLOOR_CELLS) return null;
  return new Set(best);
}

// Строит общие данные один раз при загрузке: скелет всего подземелья как дерево
// (а не линию), вес каждого поддерева (в пикселях) и функцию перевода узла скелета
// в пиксельные координаты. На основе этого дерева маршруты под участников режутся
// по рёбрам (см. splitTreeIntoPieces), а не по произвольной точке на линии —
// так разным участникам никогда не достаётся один и тот же кусок коридора.
function buildMasterData(grid, gridSize) {
  const cellSet = largestComponent(grid, gridSize);
  if (!cellSet) return null;

  let rowMin = gridSize, rowMax = -1, colMin = gridSize, colMax = -1;
  for (const idx of cellSet) {
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    if (r < rowMin) rowMin = r;
    if (r > rowMax) rowMax = r;
    if (c < colMin) colMin = c;
    if (c > colMax) colMax = c;
  }

  const pad = 1;
  const lw = colMax - colMin + 1 + pad * 2;
  const lh = rowMax - rowMin + 1 + pad * 2;
  const bin = new Uint8Array(lw * lh);
  for (const idx of cellSet) {
    const r = Math.floor(idx / gridSize) - rowMin + pad;
    const c = (idx % gridSize) - colMin + pad;
    bin[r * lw + c] = 1;
  }

  const skeleton = zhangSuenThin(bin, lw, lh);
  const tree = buildSpanningTree(skeleton, lw, lh);
  if (!tree) return null;

  const cellPx = GRID_CELL;
  const toPixel = (localIdx) => {
    const r = Math.floor(localIdx / lw) - pad + rowMin;
    const c = (localIdx % lw) - pad + colMin;
    return { x: (c + 0.5) * cellPx, y: (r + 0.5) * cellPx };
  };

  const proximityChords = findProximityChords(tree, toPixel, cellSet, gridSize, PROXIMITY_MAX_DIST, PROXIMITY_MIN_RATIO);
  const allCandidateEdges = tree.extraEdges.concat(proximityChords);
  // Длина кольца не зависит от того, как дерево позже порежут на куски — это можно
  // посчитать один раз. А вот КАКИЕ из пересекающихся по рёбрам колец реально
  // использовать — зависит от конкретного куска (см. selectNonOverlappingLoops,
  // вызывается для каждого участника отдельно в buildTourFromRoot).
  tree.loopCandidates = filterCandidatesByLength(tree, toPixel, MIN_LOOP_LENGTH, allCandidateEdges);

  const subtreeWeight = computeSubtreeWeights(tree, toPixel);
  const totalWeight = subtreeWeight.get(tree.root);

  return { tree, toPixel, subtreeWeight, totalWeight, cellSet, gridSize };
}

// Утончение контура до линии толщиной в одну ячейку (классический алгоритм Zhang-Suen),
// чтобы путь шёл по центру прохода и сам огибал препятствия.
function zhangSuenThin(bin, w, h) {
  const img = bin.slice();
  const get = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return 0;
    return img[y * w + x];
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [1, 2]) {
      const toRemove = [];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!get(x, y)) continue;
          const neighbors = [
            get(x, y - 1), get(x + 1, y - 1), get(x + 1, y), get(x + 1, y + 1),
            get(x, y + 1), get(x - 1, y + 1), get(x - 1, y), get(x - 1, y - 1),
          ];
          const [p2, p3, p4, p5, p6, p7, p8, p9] = neighbors;
          const B = neighbors.reduce((a, b) => a + b, 0);
          if (B < 2 || B > 6) continue;

          let A = 0;
          for (let k = 0; k < 8; k++) {
            if (neighbors[k] === 0 && neighbors[(k + 1) % 8] === 1) A++;
          }
          if (A !== 1) continue;

          if (step === 1) {
            if (p2 * p4 * p6 !== 0) continue;
            if (p4 * p6 * p8 !== 0) continue;
          } else {
            if (p2 * p4 * p8 !== 0) continue;
            if (p2 * p6 * p8 !== 0) continue;
          }
          toRemove.push(y * w + x);
        }
      }
      if (toRemove.length) {
        changed = true;
        for (const idx of toRemove) img[idx] = 0;
      }
    }
  }
  return img;
}

// Остовное дерево скелета через BFS (циклы отбрасываются — это не теряет узлы,
// просто убирает лишние короткие пути). order — узлы в порядке BFS от корня,
// что удобно для последующего подсчёта весов поддеревьев в обратном порядке.
function buildSpanningTree(skeleton, w, h) {
  const cells = [];
  for (let i = 0; i < skeleton.length; i++) if (skeleton[i]) cells.push(i);
  if (cells.length === 0) return null;

  const neighborsOf = (i) => {
    const x = i % w, y = Math.floor(i / w);
    const result = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (skeleton[ni]) result.push(ni);
      }
    }
    return result;
  };

  const root = cells[0];
  const visited = new Set([root]);
  const children = new Map();
  const parent = new Map();
  const order = [root];
  const extraEdges = [];
  const extraEdgeSeen = new Set();
  let qi = 0;
  while (qi < order.length) {
    const cur = order[qi++];
    const kids = [];
    for (const n of neighborsOf(cur)) {
      if (!visited.has(n)) {
        visited.add(n);
        parent.set(n, cur);
        kids.push(n);
        order.push(n);
      } else if (n !== parent.get(cur)) {
        // ребро к уже посещённой клетке, которая не наш родитель — это хорда,
        // она замыкает цикл (кольцевой коридор), который обычное дерево теряет.
        const key = cur < n ? `${cur}_${n}` : `${n}_${cur}`;
        if (!extraEdgeSeen.has(key)) {
          extraEdgeSeen.add(key);
          extraEdges.push([cur, n]);
        }
      }
    }
    children.set(cur, kids);
  }

  return { root, children, parent, order, extraEdges };
}

// Ближайший общий предок двух узлов дерева (обычный приём: подняться от одного
// до корня, собрав предков в Set, затем подниматься от другого до первого common).
function findLCA(tree, a, b) {
  const ancestors = new Set();
  let cur = a;
  while (cur !== undefined) {
    ancestors.add(cur);
    cur = tree.parent.get(cur);
  }
  cur = b;
  while (cur !== undefined) {
    if (ancestors.has(cur)) return cur;
    cur = tree.parent.get(cur);
  }
  return tree.root;
}

// Прямой потомок узла L, через которого проходит путь вниз к узлу x.
function childTowardNode(tree, L, x) {
  let cur = x;
  while (tree.parent.get(cur) !== L) {
    cur = tree.parent.get(cur);
  }
  return cur;
}

function filterCandidatesByLength(tree, toPixel, minLength, candidateEdges) {
  const armPath = (node, lca) => {
    const path = [];
    let cur = node;
    while (cur !== lca) {
      const p = tree.parent.get(cur);
      path.push(p < cur ? `${p}_${cur}` : `${cur}_${p}`);
      cur = p;
    }
    return path;
  };

  const result = [];
  for (const [a, b] of candidateEdges) {
    const lca = findLCA(tree, a, b);
    if (lca === a || lca === b) continue;
    const edgeKeys = [...armPath(a, lca), ...armPath(b, lca)];
    let length = 0;
    for (const key of edgeKeys) {
      const [x, y] = key.split("_").map(Number);
      length += dist(toPixel(x), toPixel(y));
    }
    if (length >= minLength) result.push({ a, b, edgeKeys, length });
  }
  return result;
}

// Утончение часто даёт НЕСКОЛЬКО хорд-кандидатов на одно и то же физическое кольцо
// (соседние диагональные перемычки около широкой развилки), а некоторые кольца
// пересекаются по стволу дерева с другими. Выбираем САМЫЕ крупные первыми и
// пропускаем те, что делят рёбра с уже выбранным кольцом — иначе дуга дважды
// "используется" двумя разными петлями, и обход считает узлы по несколько раз.
// ВАЖНО: это делается ОТДЕЛЬНО для каждого куска (после разбиения на участников),
// а не один раз глобально — иначе большое кольцо может "занять" дедуп-слот у
// маленького, даже если потом при разрезании дерева его концы попадут в РАЗНЫЕ
// куски и само оно окажется никому не нужно, а маленькое кольцо было бы реально
// полезно внутри своего куска.
function selectNonOverlappingLoops(candidates, tree, severed, pieceRoot) {
  const usable = candidates.filter(
    (c) =>
      findPieceRoot(tree, c.a, severed) === pieceRoot && findPieceRoot(tree, c.b, severed) === pieceRoot
  );
  usable.sort((x, y) => y.length - x.length);

  const usedEdges = new Set();
  const result = [];
  for (const cand of usable) {
    if (cand.edgeKeys.some((k) => usedEdges.has(k))) continue;
    for (const k of cand.edgeKeys) usedEdges.add(k);
    result.push([cand.a, cand.b]);
  }
  return result;
}

// Хорды из обхода скелета ловят только буквальное соседство пикселей (1 клетка).
// Но часто две ветки дерева проходят физически РЯДОМ (огибают с двух сторон
// маленький островок-препятствие, или две "ноги" широкой комнаты), не будучи
// соседями в графе — там путь всё равно идёт туда-обратно вместо обхода по кругу.
// Ищем такие пары в лоб: близко в пикселях, далеко по дереву, прямая видимость
// без стен — это даёт тот же эффект "короткой перемычки", что и настоящая хорда.
function findProximityChords(tree, toPixel, cellSet, gridSize, maxDist, minRatio) {
  const nodes = tree.order;
  const result = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const pa = toPixel(a);
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      if (tree.parent.get(a) === b || tree.parent.get(b) === a) continue;
      const pb = toPixel(b);
      const d = dist(pa, pb);
      if (d > maxDist || d < 1) continue;
      if (!lineOfSight(cellSet, gridSize, pa, pb)) continue;

      const lca = findLCA(tree, a, b);
      if (lca === a || lca === b) continue;

      let treeDist = 0;
      let cur = a;
      while (cur !== lca) {
        const p = tree.parent.get(cur);
        treeDist += dist(toPixel(cur), toPixel(p));
        cur = p;
      }
      cur = b;
      while (cur !== lca) {
        const p = tree.parent.get(cur);
        treeDist += dist(toPixel(cur), toPixel(p));
        cur = p;
      }

      if (treeDist < d * minRatio) continue;
      result.push([a, b]);
    }
  }
  return result;
}

// Вес поддерева каждого узла = суммарная длина (в пикселях) всех рёбер под ним.
// Считаем в обратном порядке BFS — так дети всегда посчитаны раньше родителя,
// без рекурсии (дерево скелета может быть глубоким).
function computeSubtreeWeights(tree, toPixel) {
  const weight = new Map();
  for (let i = tree.order.length - 1; i >= 0; i--) {
    const node = tree.order[i];
    let w = 0;
    for (const child of tree.children.get(node)) {
      w += dist(toPixel(node), toPixel(child)) + weight.get(child);
    }
    weight.set(node, w);
  }
  return weight;
}

// Какому куску (родоначальнику) принадлежит узел: поднимаемся по дереву, пока не
// упрёмся в сам корень куска или в узел из severed (он — корень ДРУГОГО куска).
function findPieceRoot(tree, node, severed) {
  let cur = node;
  while (true) {
    if (severed.has(cur) || cur === tree.root) return cur;
    cur = tree.parent.get(cur);
  }
}

// Обход (DFS) поддерева, начиная с заданного узла, пропуская детей из severed
// (они "отрезаны" и обходятся отдельным участником). По умолчанию каждое ребро
// проходится туда-обратно — НО если внутри куска есть хорда (цикл/кольцевой
// коридор, который обычное дерево потеряло), она используется, чтобы пройти
// кольцо один раз по кругу: вниз по одной "руке" до точки u, через хорду на v,
// и обратно вверх по ВТОРОЙ "руке" — т.е. туда и обратно разными путями, а не
// тем же самым коридором. Так ни одно ответвление не остаётся без внимания,
// а явные кольца не превращаются в тупик с разворотом.
function buildTourFromRoot(tree, root, severed) {
  const { children, parent } = tree;

  const blockedAt = new Map(); // node -> Set(заблокированных прямых детей)
  const loopAt = new Map(); // node (u) -> { v, lca }

  const pieceLoops = selectNonOverlappingLoops(tree.loopCandidates, tree, severed, root);
  for (const [a, b] of pieceLoops) {
    const lca = findLCA(tree, a, b);
    const [u, v] = loopAt.has(a) ? [b, a] : [a, b];
    if (loopAt.has(u) || loopAt.has(v)) continue; // перестраховка от конфликта общего узла

    loopAt.set(u, { v, lca });
    const vEntryChild = childTowardNode(tree, lca, v);
    if (!blockedAt.has(lca)) blockedAt.set(lca, new Set());
    blockedAt.get(lca).add(vEntryChild);
  }

  const tour = [];
  const usedInLoop = new Set();

  function kidsOf(node, skip) {
    const blocked = blockedAt.get(node);
    return (children.get(node) || []).filter(
      (c) => !severed.has(c) && c !== skip && !(blocked && blocked.has(c))
    );
  }

  function visitNormal(node, skip) {
    tour.push(node);
    for (const c of kidsOf(node, skip)) {
      visitNormal(c, null);
      tour.push(node);
    }
    const loop = loopAt.get(node);
    if (loop && !usedInLoop.has(node) && !usedInLoop.has(loop.v)) {
      usedInLoop.add(node);
      usedInLoop.add(loop.v);
      closeLoop(loop.v, loop.lca);
      // closeLoop физически заканчивает обход в loop.lca, а не в node — вызывающий
      // код (который продолжит свой обычный backtrack) думает, что мы всё ещё в
      // node, и после возврата сюда просто запишет СВОЙ узел как следующую точку.
      // Без явного спуска это дало бы несвязанный прыжок lca → caller (мимо всех
      // промежуточных клеток) — ровно тот артефакт, когда линия идёт напрямик
      // через стену. Поэтому явно спускаемся обратно вниз по дереву от lca к
      // node простыми шагами (боковые ветки по пути уже пройдены, здесь не
      // исследуем их заново).
      const pathDown = [];
      let cur = node;
      while (cur !== loop.lca) {
        pathDown.push(cur);
        cur = parent.get(cur);
      }
      pathDown.reverse();
      for (const p of pathDown) tour.push(p);
    }
  }

  // Прошли хорду u→v, теперь обходим "вторую руку" кольца от v вверх до lca —
  // на каждом шаге попутно посещая боковые ответвления этой руки как обычно.
  function closeLoop(v, lca) {
    tour.push(v);
    for (const c of kidsOf(v, null)) {
      visitNormal(c, null);
      tour.push(v);
    }
    let prev = v;
    let p = parent.get(v);
    while (p !== undefined) {
      tour.push(p);
      if (p === lca) break; // дошли до точки ветвления — её дети уже пройдены при первом спуске сюда
      for (const c of kidsOf(p, prev)) {
        visitNormal(c, null);
        tour.push(p);
      }
      prev = p;
      p = parent.get(p);
    }
  }

  visitNormal(root, null);
  return tour;
}

// Проверяет, что прямая между двумя точками целиком идёт по проходимым клеткам
// (не задевает препятствия/стены) — шаг сэмплирования мельче половины клетки.
function lineOfSight(cellSet, gridSize, p1, p2) {
  const steps = Math.max(1, Math.ceil(dist(p1, p2) / (GRID_CELL / 2)));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = p1.x + (p2.x - p1.x) * t;
    const y = p1.y + (p2.y - p1.y) * t;
    // Клетка c занимает пиксели [c*GRID_CELL, (c+1)*GRID_CELL) — floor, а не round
    // (round на границе .5, которая у нас совпадает с центром клетки, может
    // округлить не в ту сторону и проверить соседнюю клетку вместо нужной).
    const c = Math.floor(x / GRID_CELL);
    const r = Math.floor(y / GRID_CELL);
    if (r < 0 || r >= gridSize || c < 0 || c >= gridSize) return false;
    if (!cellSet.has(r * gridSize + c)) return false;
  }
  return true;
}

// Упрощение ломаной с учётом препятствий ("string pulling"): от текущей точки
// тянемся максимально далеко вперёд (но не дальше окна LOOKAHEAD), пока прямая до
// кандидата не пересекает стену — получаем чёткие отрезки "точка А → точка Б",
// не задевающие стены. Окно обязательно: полный обход подземелья возвращается в
// стартовую точку, и без ограничения жадный поиск "самой дальней видимой точки"
// тут же нашёл бы саму стартовую точку в конце массива и схлопнул бы весь обход
// в одну точку — окно не даёт переступить через ещё не пройденные ответвления.
const SIMPLIFY_LOOKAHEAD = 40;

function simplifyWithLineOfSight(points, cellSet, gridSize) {
  if (points.length < 3) return points;
  const out = [points[0]];
  let anchorIdx = 0;
  while (anchorIdx < points.length - 1) {
    const limit = Math.min(points.length - 1, anchorIdx + SIMPLIFY_LOOKAHEAD);
    let farthest = anchorIdx + 1;
    for (let j = limit; j > anchorIdx; j--) {
      if (lineOfSight(cellSet, gridSize, points[anchorIdx], points[j])) {
        farthest = j;
        break;
      }
    }
    out.push(points[farthest]);
    anchorIdx = farthest;
  }
  return out;
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += dist(points[i - 1], points[i]);
  }
  return len;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/* ---------- деление дерева на N непересекающихся кусков под участников ---------- */

// Режем дерево на N веток по рёбрам (а не линию по произвольной точке) — так куски
// никогда не делят пополам один и тот же коридор между двумя участниками. На каждом
// шаге берём самый "тяжёлый" (длинный) из текущих кусков и внутри него ищем ребро,
// отсечение которого даёт поддерево весом ближе всего к ОБЩЕЙ средней цели
// (totalWeight/n) — это даёт более ровный результат для любого n, чем деление
// пополам (которое хорошо только для n степени двойки).
//
// Вес поддерева каждого узла хранится в liveWeight и обновляется "вживую": когда
// где-то внутри него отрезают дочернюю ветку, вес вычитается у всех предков вверх
// до корня дерева. Без этого узел-предок уже отрезанной ветки продолжал бы
// считаться со старым (раздутым) весом, который на самом деле ему больше не
// принадлежит — куски получались бы фиктивно большими или вовсе пустыми.
function splitTreeIntoPieces(masterData, n) {
  const { tree, subtreeWeight, totalWeight } = masterData;
  const severed = new Set();
  const liveWeight = new Map(subtreeWeight);
  const pieceRoots = [tree.root];
  const target = totalWeight / n;

  while (pieceRoots.length < n) {
    pieceRoots.sort((a, b) => liveWeight.get(b) - liveWeight.get(a));
    const root = pieceRoots[0];

    let best = null;
    let bestDiff = Infinity;
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      const kids = (tree.children.get(node) || []).filter((c) => !severed.has(c));
      for (const c of kids) {
        const w = liveWeight.get(c);
        const diff = Math.abs(w - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
        stack.push(c);
      }
    }

    if (best === null) break; // в этом куске больше нечего резать (голая ветка-лист)

    severed.add(best);
    const cutWeight = liveWeight.get(best);
    let p = tree.parent.get(best);
    while (p !== undefined) {
      liveWeight.set(p, liveWeight.get(p) - cutWeight);
      p = tree.parent.get(p);
    }
    pieceRoots.push(best);
  }

  return { pieceRoots, severed };
}

function buildRoutes(n) {
  if (n <= 0 || !state.masterData) return [];
  const masterData = state.masterData;
  const { pieceRoots, severed } = splitTreeIntoPieces(masterData, n);

  return pieceRoots.map((root) => {
    const localTour = buildTourFromRoot(masterData.tree, root, severed);
    const pixelPoints = localTour.map(masterData.toPixel);
    const simplified = simplifyWithLineOfSight(pixelPoints, masterData.cellSet, masterData.gridSize);
    return { points: simplified, length: pathLength(simplified) };
  });
}

/* ---------- ссылка-шаринг ---------- */

// Кодируем состав участников (имена и их порядок = назначение линий) в
// компактную URL-safe строку для параметра ?h=... — маршруты детерминированы
// (buildRoutes не использует Math.random), так что то же число участников
// на том же пресете карты даст идентичный результат у получателя ссылки.
function encodeShareState(names) {
  const json = JSON.stringify({ names });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeShareState(h) {
  try {
    const b64 = h.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = decodeURIComponent(escape(atob(padded)));
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed?.names)) return null;
    return parsed.names.map((x) => String(x));
  } catch {
    return null;
  }
}

async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // упадёт в prompt ниже
    }
  }
  prompt("Скопируй ссылку вручную:", text);
  return false;
}

/* ---------- UI ---------- */

function bindUI() {
  document.getElementById("addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("nameInput");
    const name = input.value.trim();
    if (!name) return;
    state.participants.push({ id: nextId++, name });
    input.value = "";
    renderAll();
  });

  document.getElementById("clearBtn").addEventListener("click", () => {
    state.participants = [];
    editingId = null;
    renderAll();
  });

  document.getElementById("shareLinkBtn").addEventListener("click", async () => {
    const hint = document.getElementById("shareLinkHint");
    if (!state.participants.length) {
      hint.textContent = "Сначала добавь участников";
      setTimeout(() => (hint.textContent = ""), 1800);
      return;
    }
    const encoded = encodeShareState(state.participants.map((p) => p.name));
    const url = `${location.origin}${location.pathname}?h=${encoded}#/`;
    const copied = await copyToClipboard(url);
    hint.textContent = copied ? "Ссылка скопирована" : "";
    if (copied) setTimeout(() => (hint.textContent = ""), 1800);
  });

  document.getElementById("animToggle").addEventListener("change", (e) => {
    state.animate = e.target.checked;
    drawScene(performance.now());
  });

  document.getElementById("debugToggle")?.addEventListener("change", renderDebug);

  // Клик/тап вне поля редактирования и вне кнопок-карандашей — выход из
  // редактирования текущей строки (с применением/откатом имени, см. finishEditing).
  document.addEventListener("pointerdown", (e) => {
    if (editingId === null) return;
    const target = e.target;
    if (target.closest(".participant-name-input") || target.closest(".edit-btn")) return;
    finishEditing();
  });
}

function renderAll() {
  state.routes = buildRoutes(state.participants.length);
  renderList();
  renderStats();
  renderDebug();
  drawScene(performance.now());
}

function renderStats() {
  const hint = document.getElementById("emptyHint");
  hint.style.display = !isViewMode && state.participants.length === 0 ? "block" : "none";
}

// Пустое имя при выходе из редактирования не применяется — остаётся то, что было.
function commitOrRevertEditing(id) {
  const p = state.participants.find((x) => x.id === id);
  if (p && p.name.trim() === "") p.name = editingOriginalName;
}

// Переключение на редактирование другой строки сперва закрывает текущую
// (применяя или откатывая её значение), а не оставляет обе строки открытыми.
function startEditing(p) {
  if (editingId !== null && editingId !== p.id) {
    commitOrRevertEditing(editingId);
  }
  editingId = p.id;
  editingOriginalName = p.name;
  renderList();
  renderDebug();
  drawScene(performance.now());
}

function finishEditing() {
  if (editingId === null) return;
  commitOrRevertEditing(editingId);
  editingId = null;
  editingOriginalName = "";
  renderList();
  renderDebug();
  drawScene(performance.now());
}

function renderDebug() {
  const pre = document.getElementById("debugOutput");
  if (!pre) return;
  const on = document.getElementById("debugToggle")?.checked ?? false;
  pre.style.display = on ? "block" : "none";
  if (!on) return;

  if (!state.routes.length) {
    pre.textContent = "Нет участников.";
    return;
  }

  const lines = state.routes.map((route, idx) => {
    const name = state.participants[idx] ? state.participants[idx].name || "(без имени)" : "?";
    const pts = route.points.map((p) => `(${Math.round(p.x)},${Math.round(p.y)})`).join(" ");
    return `#${idx + 1} ${name} — ${route.points.length} точек, ${Math.round(route.length)}px\n  ${pts}`;
  });

  pre.textContent = lines.join("\n\n");
}

function renderList() {
  const list = document.getElementById("participantList");
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
    const route = state.routes[idx];
    const lenLabel = route ? `${Math.round(route.length)}` : "";

    li.innerHTML = `
      ${isViewMode ? "" : '<span class="handle">⋮⋮</span>'}
      <span class="route-badge" style="background:${color}">${idx + 1}</span>
      ${
        isEditing
          ? `<input class="participant-name-input" type="text" maxlength="24" value="${escapeHtml(p.name)}" />`
          : `<span class="participant-name">${escapeHtml(p.name)}</span>`
      }
      <span class="route-length">${lenLabel}</span>
      ${
        isViewMode
          ? ""
          : `<button class="edit-btn" aria-label="${isEditing ? "Готово" : "Редактировать имя"}">${isEditing ? "✕" : "✎"}</button>
             <button class="remove-btn" aria-label="Удалить">🗑</button>`
      }
    `;

    if (!isViewMode) {
      const editBtn = li.querySelector(".edit-btn");
      if (isEditing) {
        const input = li.querySelector(".participant-name-input");
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

      li.querySelector(".remove-btn").addEventListener("click", () => {
        if (editingId === p.id) editingId = null;
        state.participants.splice(idx, 1);
        renderAll();
      });
    }

    if (!isViewMode) {
      const handle = li.querySelector(".handle");

      // move/up вешаем на document, а не на handle: во время драга handle
      // пересоздаётся при каждой перестановке строк (renderList внутри onMove),
      // и любые слушатели/pointer capture на самом handle теряются вместе с
      // ним — если финальный pointerup случится уже после пересоздания, он
      // никуда не попадёт, и драг "залипнет". document не пересоздаётся никогда.
      handle.addEventListener("pointerdown", () => {
        dragFromIndex = idx;
        list.classList.add("dim-others");
        li.classList.add("dragging", "active-row");
        drawScene(performance.now());

        const onMove = (e) => {
          if (dragFromIndex === null) return;
          const rows = Array.from(list.querySelectorAll(".participant-row"));
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
            if (newRow) newRow.classList.add("dragging");
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

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- отрисовка канвы ---------- */

function pointAtDistance(points, cum, d) {
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

function cumulative(points) {
  const cum = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + dist(points[i - 1], points[i]));
  return cum;
}

function drawScene(now) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // Та же активная строка, что подсвечена в списке справа, — тот же индекс
  // (маршрут привязан к позиции в state.participants, см. renderList).
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
        const cycle = total * 2;
        const phase = (idx / Math.max(1, state.routes.length)) * cycle;
        const t = ((now / 1000) * RUN_SPEED_PX_S + phase) % cycle;
        const d = t > total ? cycle - t : t;
        const pos = pointAtDistance(route.points, cum, d);
        drawRunner(pos.x, pos.y, color);
        const name = state.participants[idx]?.name || `Игрок ${idx + 1}`;
        drawNameLabel(pos.x, pos.y, name, color);
      }
    }

    ctx.restore();
  });
}

function drawBadge(x, y, color, label) {
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

function drawRunner(x, y, color) {
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

// Имя участника "ездит" вместе с бегущей точкой — привязано по центру сверху.
function drawNameLabel(x, y, name, color) {
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

function tick(now) {
  if (state.animate && state.routes.length) {
    drawScene(now);
  }
  requestAnimationFrame(tick);
}
