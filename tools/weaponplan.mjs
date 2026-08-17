// Draws a side-profile blueprint sheet for every weapon in the roster.
//
//   node tools/weaponplan.mjs
//
// These are modelling references, not game data: real millimetres, a bore
// centreline to build around, dimension chains and named parts. One sheet per
// weapon in docs/weapons/, plus docs/weapons.html to flip through them.
//
// Naming rule: no sheet carries a manufacturer's name or model number. A
// weapon is described by its class, calibre and mechanism — that identifies it
// to us without borrowing anyone's trademark. Working codenames are ours.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT = join(ROOT, 'docs/weapons');

const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const n = (v) => Math.round(v * 10) / 10;

// ---------------------------------------------------------------------------
// The painter. Everything is in millimetres: x runs rearward from the muzzle
// (x = 0 is the tip of the muzzle device), y is measured from the bore axis,
// positive up. That is the frame a modeller actually wants — the bore is the
// one line every part is aligned to.
// ---------------------------------------------------------------------------

function painter() {
  const shapes = [];
  const calls = [];
  const dims = [];
  const api = {
    shapes, calls, dims,
    rect: (x1, y1, x2, y2, cls) => { shapes.push({ k: 'r', x1, y1, x2, y2, cls }); return api; },
    poly: (pts, cls) => { shapes.push({ k: 'p', pts, cls }); return api; },
    circle: (x, y, r, cls) => { shapes.push({ k: 'c', x, y, r, cls }); return api; },
    call: (x, y, side, text) => { calls.push({ x, y, side, text }); return api; },
    dim: (x1, x2, text, row = 0) => { dims.push({ k: 'h', x1, x2, text, row }); return api; },
    vdim: (x, y1, y2, text) => { dims.push({ k: 'v', x, y1, y2, text }); return api; },

    // --- parts -------------------------------------------------------------

    // Muzzle device: a slotted brake. Ports are cut on the top, where a brake
    // vents to fight the climb.
    brake(x0, x1, r, label = 'дульный тормоз') {
      api.rect(x0, -r, x1, r, 'metal');
      const slots = Math.max(3, Math.round((x1 - x0) / 22));
      for (let i = 0; i < slots; i++) {
        const sx = x0 + 6 + ((x1 - x0 - 12) * i) / slots;
        api.rect(sx, r * 0.25, sx + (x1 - x0) / (slots * 2.4), r, 'cut');
      }
      return api.call((x0 + x1) / 2, r, 'up', label);
    },

    barrel(x0, x1, r, label) {
      api.rect(x0, -r, x1, r, 'metal');
      return label ? api.call((x0 + x1) / 2, -r, 'down', label) : api;
    },

    // Underbarrel magazine tube of a pump gun.
    tube(x0, x1, yTop, r) {
      api.rect(x0, yTop - r * 2, x1, yTop, 'metal');
      return api.call((x0 + x1) / 2, yTop - r * 2, 'down', 'подствольный магазин, 7 патронов');
    },

    // Free-float handguard. M-LOK slots on the underside are where the light
    // and the foregrip bolt on, so they are drawn, not implied.
    handguard(x0, x1, up, down, label = 'цевьё, слоты M-LOK') {
      api.rect(x0, -down, x1, up, 'polymer');
      const slots = Math.max(2, Math.round((x1 - x0) / 90));
      for (let i = 0; i < slots; i++) {
        const sx = x0 + 24 + ((x1 - x0 - 40) * i) / slots;
        api.rect(sx, -down + 4, sx + 42, -down + 11, 'cut');
      }
      return api.call((x0 + x1) / 2, -down, 'down', label);
    },

    // Continuous top rail, drawn with its teeth so the optic has somewhere to
    // sit. Picatinny pitch is 10 mm — that is the number to model to.
    rail(x0, x1, y, label = 'верхняя планка Пикатинни, шаг 10 мм') {
      api.rect(x0, y, x1, y + 10, 'accent');
      for (let sx = x0 + 4; sx < x1 - 6; sx += 10) api.rect(sx, y + 6, sx + 4, y + 10, 'cut');
      return api.call(x0 + (x1 - x0) * 0.22, y + 10, 'up', label);
    },

    receiver(x0, x1, up, down, label = 'ствольная коробка') {
      api.rect(x0, -down, x1, up, 'metal');
      return api.call(x0 + (x1 - x0) * 0.55, up, 'up', label);
    },

    // Pistol grip: a slab raked back from the receiver underside.
    grip(x0, bottomY, y0, rake = 34, w = 78, label = 'пистолетная рукоять') {
      api.poly([
        [x0, y0], [x0 + w, y0], [x0 + w + rake, bottomY], [x0 + rake - 6, bottomY],
      ], 'polymer');
      return api.call(x0 + w / 2 + rake, bottomY, 'down', label);
    },

    // Lower receiver and magazine well. The magazine starts at its underside,
    // not at the bore — leave it out and every gun looks like a toy.
    lower(x0, x1, y0, y1) {
      api.rect(x0, y1, x1, y0, 'metal');
      return api.call(x0 + (x1 - x0) * 0.2, y1, 'down', 'нижняя коробка, шахта магазина');
    },

    triggerGuard(x0, x1, y0, depth = 46) {
      api.poly([
        [x0, y0], [x1, y0], [x1, y0 - depth + 12], [x1 - 12, y0 - depth],
        [x0 + 12, y0 - depth], [x0, y0 - depth + 12],
      ], 'metal');
      return api;
    },

    // Box magazine. `curve` bows it forward like a rifle mag; 0 is straight.
    mag(x0, x1, y0, y1, curve = 0, label = 'магазин') {
      const w = x1 - x0;
      api.poly([
        [x0, y0], [x1, y0], [x1 - curve, y1], [x1 - curve - w, y1],
      ], 'polymer');
      return api.call(x0 + w / 2 - curve, y1, 'down', label);
    },

    // Collapsible tube stock with a cheek line and a butt pad.
    stock(x0, x1, up, down, label = 'приклад телескопический, 5 позиций') {
      api.rect(x0, -14, x1 - 26, 16, 'metal');
      api.poly([
        [x0 + 40, up], [x1 - 30, up], [x1 - 30, -down], [x0 + 70, -down],
      ], 'polymer');
      api.rect(x1 - 30, -down - 6, x1, up + 4, 'rubber');
      return api.call(x1 - 60, up, 'up', label);
    },

    fixedStock(x0, x1, up, down, label = 'приклад складной, с щекой') {
      api.poly([
        [x0, up], [x1 - 24, up + 6], [x1 - 24, -down], [x0 + 30, -down],
      ], 'polymer');
      api.rect(x1 - 24, -down - 6, x1, up + 10, 'rubber');
      return api.call(x1 - 70, up + 6, 'up', label);
    },

    // The optic sits on the rail and is meant to come off: every sheet marks
    // the mount, not just the sight.
    optic(x0, x1, railY, h, kind = 'коллиматор — сменный') {
      const base = railY + 10;
      api.rect(x0 + 14, base, x0 + 44, base + h * 0.45, 'accent');
      api.rect(x1 - 44, base, x1 - 14, base + h * 0.45, 'accent');
      api.rect(x0, base + h * 0.4, x1, base + h, 'metal');
      api.rect(x0 + 4, base + h * 0.5, x0 + 16, base + h - 6, 'glass');
      api.rect(x1 - 16, base + h * 0.5, x1 - 4, base + h - 6, 'glass');
      api.call(x0 + (x1 - x0) * 0.5, base + h, 'up', kind);
      return api.call(x0 + 30, base, 'up', 'посадка на планку');
    },

    scope(x0, x1, railY, h) {
      const base = railY + 10;
      api.rect(x0 + 30, base, x0 + 58, base + h * 0.5, 'accent');
      api.rect(x1 - 90, base, x1 - 62, base + h * 0.5, 'accent');
      api.rect(x0, base + h * 0.42, x1, base + h * 0.88, 'metal');
      api.rect(x0, base + h * 0.34, x0 + 60, base + h * 0.96, 'metal');
      api.rect(x1 - 62, base + h * 0.3, x1, base + h, 'metal');
      api.rect(x1 - 10, base + h * 0.34, x1, base + h * 0.96, 'glass');
      api.rect(x0, base + h * 0.4, x0 + 8, base + h * 0.9, 'glass');
      return api.call(x0 + (x1 - x0) * 0.45, base + h * 0.88, 'up', 'оптика — сменная');
    },

    light(x0, x1, yc, r = 11) {
      api.rect(x0 + 16, yc - r, x1, yc + r, 'metal');
      api.rect(x0, yc - r - 3, x0 + 16, yc + r + 3, 'accent');
      api.rect(x1 - 34, yc + r, x1 - 12, yc + r + 9, 'accent');
      return api.call(x0 + 20, yc - r, 'down', 'тактический фонарь');
    },

    foregrip(x0, y0, len = 92, rake = 40) {
      api.poly([
        [x0, y0], [x0 + 46, y0], [x0 + 46 + rake, y0 - len], [x0 + rake + 4, y0 - len],
      ], 'polymer');
      return api.call(x0 + 30 + rake, y0 - len, 'down', 'передняя тактическая рукоять');
    },

    bipod(x, y0, len) {
      api.poly([[x - 6, y0], [x + 20, y0], [x + 34, y0 - len], [x + 24, y0 - len]], 'metal');
      api.poly([[x - 6, y0], [x + 20, y0], [x - 20, y0 - len], [x - 30, y0 - len]], 'metal');
      return api.call(x, y0 - len, 'down', 'сошки складные');
    },

    sling(x, y, side = 'up') {
      api.circle(x, y, 9, 'accent');
      return api.call(x, y + (side === 'up' ? 9 : -9), side, 'антабка ремня');
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// The roster. Eleven sheets: 3 SMG, 3 rifles, 3 shotguns, 2 long guns.
// ---------------------------------------------------------------------------

const WEAPONS = [];
const add = (def) => WEAPONS.push(def);

// --- 1. Roller-locked 9 mm SMG ---------------------------------------------
add({
  id: 'smg-9-roller',
  slot: 'ПП 1 / 3',
  code: 'PP-9',
  title: 'Пистолет-пулемёт 9×19, роликовое запирание',
  sub: 'Эталон класса: мягкая отдача, ровный паттерн, всё среднее. Длина с разложенным прикладом 680 мм, сложенный — 490 мм.',
  oal: 680,
  notes: [
    'Ширина ствольной коробки 45 мм, цевья 52 мм, магазина 26 мм.',
    'Ствол 225 мм, темп 800 в/м, магазин 30.',
    'Приклад телескопический на трубе Ø30 мм: убирается в габарит 490 мм.',
    'Планка над осью канала ствола на 40 мм — учитывай превышение при пристрелке.',
  ],
  build(g) {
    g.brake(0, 52, 13);
    g.barrel(46, 226, 9);
    g.handguard(46, 214, 27, 30);
    g.rail(44, 494, 30);
    g.receiver(214, 494, 30, 22);
    g.rect(494, -12, 524, 18, 'metal'); // stock adapter
    g.lower(236, 424, -22, -64);
    g.mag(244, 316, -64, -212, 26, 'магазин 30 патронов 9×19');
    g.triggerGuard(352, 414, -64);
    g.grip(368, -196, -64, 30, 74);
    g.stock(520, 680, 46, 40);
    g.optic(276, 416, 30, 62);
    g.light(64, 186, -46);
    g.foregrip(150, -30, 86, 36);
    g.sling(470, 30);
    g.dim(0, 680, 'полная длина 680');
    g.dim(0, 226, 'ствол 226', 1);
    g.vdim(700, -212, 46, 'высота 258 (с магазином)');
    g.vdim(-40, 0, 40, 'планка над осью ствола 40');
  },
});

// --- 2. Bullpup PDW, 5.7 mm, top magazine ----------------------------------
add({
  id: 'smg-57-pdw',
  slot: 'ПП 2 / 3',
  code: 'PDW-57',
  title: 'ПП-буллпап 5,7 мм, магазин сверху',
  sub: 'Короткий корпус, магазин на 50 лежит горизонтально поверх коробки. Бьёт бронежилет, но урон по корпусу низкий.',
  oal: 500,
  notes: [
    'Ширина корпуса 55 мм, магазина 40 мм — самый широкий ствол в наборе.',
    'Ствол 263 мм при полной длине 500 мм: буллпап, коробка позади рукояти.',
    'Корпус — единая полимерная оболочка: моделируй как одну деталь, металл только ствол и планка.',
    'Патроны в магазине лежат поперёк и разворачиваются подавателем — виден ряд гильз сверху.',
  ],
  build(g) {
    g.brake(0, 44, 11, 'пламегаситель');
    g.barrel(38, 150, 8);
    // One-piece polymer shell: one outline from the muzzle along the top, down
    // the butt, then forward through both grips. Everything else bolts to it.
    g.poly([
      [34, 24], [104, 24], [104, 36], [142, 36], [142, 26], [430, 26],
      [468, 14], [500, 8], [500, -104], [408, -104], [392, -54],
      [356, -52], [356, -152], [296, -152], [286, -54],
      [236, -54], [222, -134], [174, -134], [166, -52],
      [96, -44], [56, -28], [34, -24],
    ], 'polymer');
    g.call(452, 20, 'up', 'корпус — единая полимерная оболочка');
    g.circle(324, -98, 20, 'cut');
    g.call(324, -120, 'down', 'отверстие под большой палец');
    g.call(198, -134, 'down', 'передний упор — часть корпуса');
    g.triggerGuard(252, 296, -54, 30);
    // Top magazine lying flat: the cartridges show through the shell.
    g.rect(134, 26, 394, 62, 'polymer');
    for (let x = 148; x < 384; x += 22) g.rect(x, 34, x + 11, 54, 'cell');
    g.call(300, 62, 'up', 'магазин 50 патронов, лежит горизонтально');
    g.rail(140, 392, 62, 'планка поверх магазина, шаг 10 мм');
    g.optic(198, 330, 62, 56);
    g.light(52, 154, -50, 10);
    g.sling(468, -70, 'down');
    g.dim(0, 500, 'полная длина 500');
    g.dim(0, 150, 'ствол в кожухе, всего 263', 1);
    g.vdim(524, -152, 62, 'высота 214 (без прицела)');
    g.vdim(-40, 0, 72, 'планка над осью ствола 72');
  },
});

// --- 3. .45 SMG, recoil-mitigating action ----------------------------------
add({
  id: 'smg-45-inline',
  slot: 'ПП 3 / 3',
  code: 'PP-45',
  title: 'ПП .45 с гасящим затвором',
  sub: 'Темп ~1100 в/м, ствол уходит вниз — подброса почти нет. Магазин входит в рукоять, отсюда высокий корпус и длинная шахта.',
  oal: 640,
  notes: [
    'Ширина коробки 48 мм, цевья 50 мм, магазина 30 мм.',
    'Ствол всего 140 мм: оружие ближнего боя, урон падает уже на 20 м.',
    'Коробка выше обычной на 15 мм — внутри вертикальный ход затвора.',
    'Приклад складывается вбок; в сложенном виде габарит 470 мм.',
  ],
  build(g) {
    g.brake(0, 46, 12);
    g.barrel(40, 142, 8);
    g.handguard(40, 190, 30, 32);
    g.rail(38, 426, 44);
    g.receiver(142, 426, 44, 30);
    g.poly([[142, 44], [426, 44], [426, 62], [180, 62]], 'metal');
    g.call(300, 62, 'up', 'высокая коробка: вертикальный ход затвора');
    g.triggerGuard(268, 318, -30, 44);
    g.poly([[296, -30], [376, -30], [376, -150], [304, -150]], 'polymer');
    g.call(336, -150, 'down', 'рукоять — она же шахта магазина');
    g.mag(304, 376, -150, -276, 0, 'магазин 25 патронов .45');
    g.fixedStock(426, 640, 40, 34);
    g.optic(212, 350, 44, 60);
    g.light(56, 174, -48);
    g.foregrip(120, -32, 88, 34);
    g.sling(416, -30, 'down');
    g.dim(0, 640, 'полная длина 640 (сложен 470)');
    g.dim(0, 142, 'ствол 142', 1);
    g.vdim(662, -276, 62, 'высота 338');
    g.vdim(-40, 0, 54, 'планка над осью ствола 54');
  },
});

// --- 4. 5.45 rifle, long-stroke piston -------------------------------------
add({
  id: 'ar-545-piston',
  slot: 'Штурмовая 1 / 3',
  code: 'AV-74',
  title: 'Автомат 5,45×39, длинный ход поршня',
  sub: 'Тяжёлая пуля, резкий подброс на первых выстрелах. Крышка коробки с планкой во всю длину — современная версия классики.',
  oal: 940,
  notes: [
    'Ширина коробки 42 мм, цевья 56 мм, магазина 26 мм.',
    'Ствол 415 мм, темп 600 в/м, магазин 30.',
    'Газовая трубка идёт над стволом — характерный второй «ствол» в профиле.',
    'Приклад телескопический, складывается вбок: габарит 700 мм.',
  ],
  build(g) {
    g.brake(0, 68, 16);
    g.barrel(60, 300, 9);
    g.rect(120, 16, 300, 34, 'metal'); // gas tube
    g.call(210, 34, 'up', 'газовая трубка');
    g.rect(148, -14, 196, 48, 'metal'); // gas block
    g.handguard(58, 302, 34, 34);
    g.rail(56, 606, 34);
    g.receiver(302, 606, 34, 26);
    g.lower(340, 526, -26, -70);
    g.mag(352, 436, -70, -256, 44, 'магазин 30 патронов 5,45×39');
    g.triggerGuard(452, 512, -70);
    g.grip(468, -206, -70, 32, 76);
    g.stock(606, 940, 52, 44);
    g.optic(392, 532, 34, 62);
    g.light(76, 200, -52);
    g.foregrip(178, -34, 92, 38);
    g.sling(586, 34);
    g.dim(0, 940, 'полная длина 940 (складной — 700)');
    g.dim(0, 415, 'ствол 415', 1);
    g.vdim(960, -256, 52, 'высота 308');
    g.vdim(-40, 0, 44, 'планка над осью ствола 44');
  },
});

// --- 5. 5.56 rifle, short-stroke piston ------------------------------------
add({
  id: 'ar-556-piston',
  slot: 'Штурмовая 2 / 3',
  code: 'AR-556',
  title: 'Карабин 5,56×45, короткий ход поршня',
  sub: 'Ровная отдача и высокая скорострельность: самый «удобный» ствол набора. Ствол 368 мм — компромисс между коридором и дистанцией.',
  oal: 800,
  notes: [
    'Ширина коробки 40 мм, цевья 52 мм, магазина 25 мм.',
    'Ствол 368 мм, темп 800 в/м, магазин 30.',
    'Верхняя планка непрерывна от цевья до коробки — оптика ставится в любую точку.',
    'Приклад телескопический на трубе Ø38 мм, 6 позиций.',
  ],
  build(g) {
    g.brake(0, 60, 14);
    g.barrel(52, 368, 9);
    g.handguard(50, 300, 32, 32);
    g.rail(48, 618, 32);
    g.receiver(344, 618, 32, 24);
    g.rect(618, 6, 652, 30, 'metal');
    g.call(636, 30, 'up', 'рукоять затвора');
    g.lower(396, 580, -24, -76);
    g.mag(404, 480, -76, -244, 22, 'магазин 30 патронов 5,56×45');
    g.triggerGuard(506, 566, -76);
    g.grip(522, -212, -76, 32, 76);
    g.stock(636, 800, 48, 42);
    g.optic(414, 554, 32, 60);
    g.light(70, 192, -50);
    g.foregrip(212, -32, 90, 36);
    g.sling(600, 32);
    g.dim(0, 800, 'полная длина 800');
    g.dim(0, 368, 'ствол 368', 1);
    g.vdim(820, -244, 48, 'высота 292');
    g.vdim(-40, 0, 42, 'планка над осью ствола 42');
  },
});

// --- 6. 5.56 rifle, side-folding stock, monolithic rail --------------------
add({
  id: 'ar-556-folder',
  slot: 'Штурмовая 3 / 3',
  code: 'AC-556',
  title: 'Карабин 5,56×45, полимерная коробка, складной приклад',
  sub: 'Длиннее и точнее второго, но тяжелее в развороте. Верх коробки и цевьё — одна монолитная планка.',
  oal: 890,
  notes: [
    'Ширина коробки 48 мм, цевья 54 мм, магазина 25 мм.',
    'Ствол 351 мм, темп 620 в/м, магазин 30.',
    'Нижняя часть коробки полимерная, верх — алюминиевый профиль с планкой.',
    'Приклад складывается вправо и регулируется по щеке; габарит 660 мм.',
  ],
  build(g) {
    g.brake(0, 62, 15);
    g.barrel(54, 351, 9);
    g.handguard(52, 300, 30, 34);
    g.rail(50, 646, 34, 'монолитная планка: цевьё и коробка заодно');
    g.receiver(330, 646, 34, 26);
    g.poly([[330, -26], [646, -26], [646, -78], [396, -78]], 'polymer');
    g.call(520, -78, 'down', 'нижняя коробка — полимер, шахта магазина');
    g.mag(396, 474, -78, -258, 20, 'магазин 30 патронов 5,56×45');
    g.triggerGuard(524, 584, -78);
    g.grip(540, -214, -78, 32, 76);
    g.fixedStock(646, 890, 52, 44);
    g.optic(408, 552, 34, 60);
    g.light(72, 194, -52);
    g.foregrip(206, -34, 90, 36);
    g.sling(640, 34);
    g.dim(0, 890, 'полная длина 890 (сложен 660)');
    g.dim(0, 351, 'ствол 351', 1);
    g.vdim(910, -258, 52, 'высота 310');
    g.vdim(-40, 0, 44, 'планка над осью ствола 44');
  },
});

// --- 7. Sawn-off double 12 gauge -------------------------------------------
add({
  id: 'sg-12-double',
  slot: 'Дробовик 1 / 3',
  code: 'SG-12D',
  title: 'Обрез двуствольный, 12 калибр',
  sub: 'Два выстрела и всё. Достаётся мгновенно, вышибает дверь с одного попадания, перезарядка долгая и открытая.',
  oal: 420,
  notes: [
    'Ширина по стволам 46 мм, по колодке 44 мм.',
    'Стволы 300 мм, спарены вертикально: в профиле видна двойная толщина.',
    'Прицела штатно нет — на колодке короткая планка под микро-коллиматор.',
    'Приклада нет: отдача уходит в кисть, стрельба только от бедра или навскидку.',
  ],
  build(g) {
    g.rect(0, 3, 300, 26, 'metal');
    g.rect(0, -26, 300, -3, 'metal');
    g.call(150, 26, 'up', 'два ствола, спарены вертикально, 300 мм');
    g.rect(0, -28, 12, 28, 'rubber');
    g.call(6, -28, 'down', 'срез стволов — без дульного устройства');
    g.poly([[298, -36], [420, -36], [420, 36], [298, 30]], 'metal');
    g.call(360, 36, 'up', 'колодка, переломная');
    g.rect(120, -54, 232, -26, 'polymer');
    g.call(176, -54, 'down', 'цевьё');
    g.rail(304, 414, 36, 'короткая планка под микро-прицел');
    g.optic(310, 408, 36, 40, 'микро-коллиматор — сменный');
    g.triggerGuard(318, 368, -36, 42);
    g.poly([[334, -36], [406, -36], [430, -172], [362, -178]], 'polymer');
    g.call(396, -178, 'down', 'пистолетная рукоять, приклада нет');
    g.light(48, 154, -66, 10);
    g.sling(410, -36, 'down');
    g.dim(0, 420, 'полная длина 420');
    g.dim(0, 300, 'стволы 300', 1);
    g.vdim(444, -178, 56, 'высота 234');
  },
});

// --- 8. Pump 12 gauge ------------------------------------------------------
add({
  id: 'sg-12-pump',
  slot: 'Дробовик 2 / 3',
  code: 'SG-12P',
  title: 'Помповое ружьё, 12 калибр, подствольный магазин',
  sub: 'Медленное и честное: между выстрелами — движение цевья. Дульная насадка для выбивания замков.',
  oal: 1000,
  notes: [
    'Ширина коробки 44 мм, цевья 58 мм.',
    'Ствол 470 мм, магазин 7 патронов, перезарядка по одному.',
    'Цевьё ходит вдоль трубки магазина на 90 мм — при анимации это единственная подвижная деталь снаружи.',
    'На коробке планка: коллиматор ставится низко, прямо над осью ствола.',
  ],
  build(g) {
    g.rect(0, -22, 52, 22, 'accent');
    g.call(26, 22, 'up', 'дульная насадка для выбивания замков');
    g.barrel(46, 470, 11);
    g.tube(60, 430, -18, 11);
    g.rect(150, -52, 304, -12, 'polymer');
    for (let x = 164; x < 292; x += 20) g.rect(x, -48, x + 9, -16, 'cut');
    g.call(226, -52, 'down', 'цевьё, ход 90 мм');
    g.receiver(470, 684, 30, 28);
    g.rail(478, 676, 30);
    g.optic(500, 640, 30, 54);
    g.rect(468, -30, 500, -66, 'metal');
    g.call(484, -66, 'down', 'окно выброса снизу');
    g.triggerGuard(566, 626, -28);
    g.poly([[598, -28], [676, -28], [700, -168], [630, -172]], 'polymer');
    g.call(660, -172, 'down', 'пистолетная рукоять');
    g.stock(684, 1000, 54, 44, 'приклад с щекой, регулируемый');
    g.light(88, 200, 40, 11);
    g.sling(966, -34, 'down');
    g.dim(0, 1000, 'полная длина 1000');
    g.dim(0, 470, 'ствол 470', 1);
    g.vdim(1020, -172, 94, 'высота 266');
    g.vdim(-40, 0, 40, 'планка над осью ствола 40');
  },
});

// --- 9. Magazine-fed semi-auto 12 gauge ------------------------------------
add({
  id: 'sg-12-mag',
  slot: 'Дробовик 3 / 3',
  code: 'SG-12M',
  title: 'Самозарядное ружьё 12 калибра с коробчатым магазином',
  sub: 'Быстрый огонь и быстрая смена магазина, но отдача уводит ствол сильнее помпы. Самый крупный магазин в наборе.',
  oal: 940,
  notes: [
    'Ширина коробки 46 мм, цевья 58 мм, магазина 62 мм — он толстый, это заметно.',
    'Ствол 430 мм, магазин 8 патронов, темп полуавтомата ~240 в/м.',
    'Газовый узел над стволом с регулятором — виден блок за мушкой.',
    'Приклад складывается вбок; в сложенном виде габарит 700 мм.',
  ],
  build(g) {
    g.brake(0, 58, 18, 'дульный тормоз-компенсатор');
    g.barrel(50, 290, 11);
    g.rect(126, 18, 290, 38, 'metal');
    g.call(200, 38, 'up', 'газовый узел с регулятором');
    g.rect(150, -16, 202, 52, 'metal');
    g.handguard(58, 292, 38, 36);
    g.rail(56, 596, 38);
    g.receiver(292, 596, 38, 28);
    g.lower(330, 548, -28, -76);
    g.mag(336, 460, -76, -286, 34, 'магазин 8 патронов, 12 калибр');
    g.triggerGuard(474, 534, -76);
    g.grip(490, -214, -76, 32, 78);
    g.fixedStock(596, 940, 56, 46);
    g.optic(374, 514, 38, 58);
    g.light(76, 202, -54);
    g.foregrip(180, -36, 92, 38);
    g.sling(580, 38);
    g.dim(0, 940, 'полная длина 940 (сложен 700)');
    g.dim(0, 430, 'ствол 430', 1);
    g.vdim(960, -286, 56, 'высота 342');
    g.vdim(-40, 0, 48, 'планка над осью ствола 48');
  },
});

// --- 10. .50 anti-materiel rifle -------------------------------------------
add({
  id: 'amr-50',
  slot: 'Крупный калибр 1 / 2',
  code: 'AMR-50',
  title: 'Крупнокалиберная винтовка .50, самозарядная',
  sub: 'Пробивает стены насквозь. Огромная, медленная в развороте, стреляет только с сошек или с упора.',
  oal: 1448,
  notes: [
    'Ширина коробки 60 мм, магазина 40 мм — деталь крупная, не масштабируй карабин.',
    'Ствол 736 мм, магазин 10 патронов.',
    'Ствол с коробкой откатывается на 25 мм при выстреле — заложи ход в риг.',
    'Сошки складываются вперёд под цевьё; в сложенном виде габарит по низу 120 мм.',
  ],
  build(g) {
    g.brake(0, 118, 30, 'дульный тормоз, три пары окон');
    g.barrel(110, 520, 15);
    g.rect(150, 30, 520, 46, 'metal');
    g.call(300, 46, 'up', 'кожух ствола с отверстиями');
    g.handguard(126, 520, 30, 44, 'цевьё с сошечным узлом');
    g.rail(124, 1150, 46);
    g.receiver(520, 1150, 46, 44, 'верхняя коробка');
    g.rect(520, 46, 1150, 66, 'metal');
    g.call(1040, 66, 'up', 'откат ствола с коробкой 25 мм');
    g.lower(690, 1040, -44, -96);
    g.mag(700, 856, -96, -320, 18, 'магазин 10 патронов .50');
    g.triggerGuard(950, 1024, -96, 52);
    g.grip(966, -236, -96, 34, 84);
    g.poly([[1150, 62], [1370, 66], [1448, 40], [1448, -70], [1330, -78], [1150, -44]], 'polymer');
    g.call(1330, 66, 'up', 'приклад с амортизатором и щекой');
    g.rect(1424, -80, 1448, 46, 'rubber');
    g.bipod(320, -44, 240);
    g.scope(560, 940, 46, 150);
    g.light(140, 300, -66, 13);
    g.sling(1160, -44, 'down');
    g.dim(0, 1448, 'полная длина 1448');
    g.dim(0, 736, 'ствол 736', 1);
    g.vdim(1474, -320, 206, 'высота 526 (с сошками и оптикой)');
    g.vdim(-40, 0, 56, 'планка над осью ствола 56');
  },
});

// --- 11. 7.62 semi-auto marksman rifle -------------------------------------
add({
  id: 'dmr-762',
  slot: 'Крупный калибр 2 / 2',
  code: 'DMR-762',
  title: 'Самозарядная винтовка 7,62×51, марксманская',
  sub: 'Два попадания в корпус, зато быстрый повтор. Компоновка карабина, но всё длиннее и тяжелее.',
  oal: 1120,
  notes: [
    'Ширина коробки 42 мм, цевья 54 мм, магазина 26 мм.',
    'Ствол 508 мм, магазин 20 патронов, темп полуавтомата ~300 в/м.',
    'Планка непрерывна на 660 мм — оптика и ночник ставятся в линию.',
    'Приклад регулируется по длине и по щеке; сошки складываются под цевьё.',
  ],
  build(g) {
    g.brake(0, 70, 15);
    g.barrel(60, 508, 10);
    g.handguard(58, 462, 32, 36);
    g.rail(56, 716, 32);
    g.receiver(462, 716, 32, 26);
    g.rect(716, 6, 754, 30, 'metal');
    g.call(736, 30, 'up', 'рукоять затвора');
    g.lower(498, 692, -26, -80);
    g.mag(506, 592, -80, -262, 16, 'магазин 20 патронов 7,62×51');
    g.triggerGuard(614, 676, -80);
    g.grip(630, -216, -80, 32, 78);
    g.stock(740, 1120, 54, 46, 'приклад регулируемый, с щекой');
    g.scope(452, 760, 32, 118);
    g.bipod(210, -36, 210);
    g.light(84, 210, -56, 11);
    g.sling(700, 32);
    g.dim(0, 1120, 'полная длина 1120');
    g.dim(0, 508, 'ствол 508', 1);
    g.vdim(1146, -262, 160, 'высота 422 (с сошками и оптикой)');
    g.vdim(-40, 0, 42, 'планка над осью ствола 42');
  },
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STYLE = `
  .bg { fill: #f7f5f1; }
  .grid { stroke: #e4e0d8; stroke-width: 1; }
  .grid.coarse { stroke: #d5d0c6; }
  text { paint-order: stroke; stroke: #f7f5f1; stroke-width: 3px; stroke-linejoin: round; }
  .metal { fill: #3a3d44; stroke: #22242a; stroke-width: 1; }
  .polymer { fill: #6f6a61; stroke: #4a463f; stroke-width: 1; }
  .rubber { fill: #26282d; stroke: #14161a; stroke-width: 1; }
  .accent { fill: #c8531f; stroke: #943d16; stroke-width: 1; }
  .glass { fill: #7fa8bd; stroke: #4f7a92; stroke-width: 1; }
  .cell { fill: #cfcabf; stroke: none; }
  .cut { fill: #f7f5f1; stroke: none; opacity: 0.85; }
  .bore { stroke: #c8531f; stroke-width: 1; stroke-dasharray: 12 4 3 4; opacity: 0.8; }
  .lead { stroke: #8d8880; stroke-width: 1; fill: none; }
  .witness { stroke: #9aa2ae; stroke-width: 1; fill: none; stroke-dasharray: 4 3; }
  .call { font: 12px system-ui, sans-serif; fill: #22242a; }
  .dimline { stroke: #4a5568; stroke-width: 1; }
  .dimtext { font: 12px ui-monospace, monospace; fill: #4a5568; text-anchor: middle; }
  .title { font: 600 22px system-ui, sans-serif; fill: #22242a; }
  .code { font: 600 22px ui-monospace, monospace; fill: #c8531f; }
  .slot { font: 12px ui-monospace, monospace; fill: #8d8880; }
  .subtitle { font: 14px system-ui, sans-serif; fill: #4d4a45; }
  .note { font: 13px system-ui, sans-serif; fill: #3d3f45; }
  .scalebar { fill: #22242a; }
  .scaletext { font: 11px ui-monospace, monospace; fill: #6b6660; }
`;

const SHEET_W = 1180;
const PAD = { left: 104, right: 60, top: 118 };
const DRAW_W = SHEET_W - PAD.left - PAD.right;

function sheet(def) {
  const g = painter();
  def.build(g);

  const scale = Math.min(1.25, DRAW_W / (def.oal * 1.08));
  const sx = (x) => PAD.left + x * scale;

  // Vertical extent of everything drawn, so the bore line lands sensibly.
  let hi = 0;
  let lo = 0;
  const seen = (y) => { if (y > hi) hi = y; if (y < lo) lo = y; };
  for (const s of g.shapes) {
    if (s.k === 'r') { seen(s.y1); seen(s.y2); }
    else if (s.k === 'p') for (const [, y] of s.pts) seen(y);
    else { seen(s.y - s.r); seen(s.y + s.r); }
  }
  for (const d of g.dims) if (d.k === 'v') { seen(d.y1); seen(d.y2); }

  // Callouts are packed into as many rows as they need: a label goes in the
  // first row where it does not touch its neighbour, so nothing is ever
  // printed on top of anything else.
  const ROW_GAP = 21;
  const CHAR_W = 6.4;
  function pack(side) {
    const rows = [];
    const placed = [];
    for (const c of g.calls.filter((k) => k.side === side).sort((a, b) => a.x - b.x)) {
      const w = c.text.length * CHAR_W;
      const x = PAD.left + c.x * scale;
      const start = Math.max(PAD.left, x - w / 2) - 10;
      const end = start + w + 20;
      let row = rows.findIndex((e) => e < start);
      if (row === -1) { row = rows.length; rows.push(0); }
      rows[row] = end;
      placed.push({ ...c, row });
    }
    return { placed, rows: rows.length };
  }
  const up = pack('up');
  const down = pack('down');
  const upBand = up.rows * ROW_GAP + 18;
  const downBand = down.rows * ROW_GAP + 18;

  const dimRows = Math.max(0, ...g.dims.filter((d) => d.k === 'h').map((d) => d.row + 1));
  const footerH = 20 + dimRows * 30 + 18 + def.notes.length * 21 + 48;

  const bodyH = (hi - lo) * scale;
  const boreY = PAD.top + upBand + hi * scale;
  const H = PAD.top + upBand + bodyH + downBand + footerH;
  const sy = (y) => boreY - y * scale;
  const footerTop = H - footerH;

  const out = [];

  // A 50 mm grid: something to count against while modelling.
  for (let x = 0; x <= def.oal + 60; x += 50) {
    out.push(`<line x1="${n(sx(x))}" y1="${n(sy(hi) - 6)}" x2="${n(sx(x))}" y2="${n(sy(lo) + 6)}" class="grid${x % 100 === 0 ? ' coarse' : ''}"/>`);
  }
  for (let y = Math.floor(lo / 50) * 50; y <= hi + 50; y += 50) {
    out.push(`<line x1="${n(sx(-30))}" y1="${n(sy(y))}" x2="${n(sx(def.oal + 40))}" y2="${n(sy(y))}" class="grid${y === 0 ? ' coarse' : ''}"/>`);
  }

  for (const s of g.shapes) {
    if (s.k === 'r') {
      const x1 = Math.min(sx(s.x1), sx(s.x2));
      const y1 = Math.min(sy(s.y1), sy(s.y2));
      out.push(`<rect x="${n(x1)}" y="${n(y1)}" width="${n(Math.abs(sx(s.x2) - sx(s.x1)))}" height="${n(Math.abs(sy(s.y2) - sy(s.y1)))}" class="${s.cls}"/>`);
    } else if (s.k === 'p') {
      out.push(`<polygon points="${s.pts.map(([x, y]) => `${n(sx(x))},${n(sy(y))}`).join(' ')}" class="${s.cls}"/>`);
    } else {
      out.push(`<circle cx="${n(sx(s.x))}" cy="${n(sy(s.y))}" r="${n(s.r * scale)}" class="${s.cls}"/>`);
    }
  }

  // Bore centreline, drawn over the parts: it is the datum everything hangs on.
  out.push(`<line x1="${n(sx(-40))}" y1="${n(boreY)}" x2="${n(sx(def.oal + 50))}" y2="${n(boreY)}" class="bore"/>`);
  out.push(`<text x="${n(sx(def.oal + 54))}" y="${n(boreY + 4)}" class="dimtext" style="text-anchor:start">ось ствола</text>`);

  // Callouts. Leaders are drawn first and text second, so a label always sits
  // on top of any line that happens to pass behind it.
  const leaders = [];
  const labels = [];
  for (const { placed, side } of [{ ...up, side: 'up' }, { ...down, side: 'down' }]) {
    const dir = side === 'up' ? -1 : 1;
    const edge = side === 'up' ? sy(hi) : sy(lo);
    for (const c of placed) {
      const ty = edge + dir * (16 + c.row * ROW_GAP) + (side === 'up' ? 0 : 4);
      const ax = sx(c.x);
      const ay = sy(c.y);
      leaders.push(`<path d="M ${n(ax)} ${n(ay)} L ${n(ax)} ${n(ty + dir * 5)}" class="lead"/>`);
      leaders.push(`<circle cx="${n(ax)}" cy="${n(ay)}" r="2" fill="#8d8880"/>`);
      const anchor = ax > SHEET_W - 90 ? 'end' : ax < PAD.left + 40 ? 'start' : 'middle';
      labels.push(`<text x="${n(ax)}" y="${n(ty)}" class="call" style="text-anchor:${anchor}">${esc(c.text)}</text>`);
    }
  }
  out.push(...leaders, ...labels);

  // Vertical dimensions stand clear of the body with a witness line pointing
  // back at what they measure; horizontal chains sit in the footer.
  for (const d of g.dims.filter((v) => v.k === 'v')) {
    const x = sx(d.x);
    const toward = d.x < 0 ? 1 : -1;
    for (const y of [d.y1, d.y2]) {
      out.push(`<path d="M ${n(x)} ${n(sy(y))} L ${n(x + toward * 56)} ${n(sy(y))}" class="witness"/>`);
    }
    const mid = (sy(d.y1) + sy(d.y2)) / 2;
    out.push(`<path d="M ${n(x - 6)} ${n(sy(d.y1))} L ${n(x + 6)} ${n(sy(d.y1))} M ${n(x)} ${n(sy(d.y1))} L ${n(x)} ${n(sy(d.y2))} M ${n(x - 6)} ${n(sy(d.y2))} L ${n(x + 6)} ${n(sy(d.y2))}" class="dimline"/>`);
    out.push(`<text x="${n(x - 7)}" y="${n(mid)}" class="dimtext" transform="rotate(-90 ${n(x - 7)} ${n(mid)})">${esc(d.text)}</text>`);
  }
  for (const d of g.dims.filter((v) => v.k === 'h')) {
    const y = footerTop + 20 + d.row * 30;
    out.push(`<path d="M ${n(sx(d.x1))} ${n(y - 6)} L ${n(sx(d.x1))} ${n(y + 6)} M ${n(sx(d.x1))} ${n(y)} L ${n(sx(d.x2))} ${n(y)} M ${n(sx(d.x2))} ${n(y - 6)} L ${n(sx(d.x2))} ${n(y + 6)}" class="dimline"/>`);
    out.push(`<text x="${n((sx(d.x1) + sx(d.x2)) / 2)}" y="${n(y - 8)}" class="dimtext">${esc(d.text)}</text>`);
  }

  const notesTop = footerTop + 20 + dimRows * 30 + 18;
  const notes = def.notes
    .map((t, i) => `<text x="${PAD.left}" y="${n(notesTop + i * 21)}" class="note">— ${esc(t)}</text>`)
    .join('\n');

  // Scale bar: 200 mm, so a screenshot stays measurable.
  const barY = notesTop + def.notes.length * 21 + 14;
  out.push(`<rect x="${n(PAD.left)}" y="${n(barY)}" width="${n(100 * scale)}" height="6" class="scalebar"/>`);
  out.push(`<rect x="${n(PAD.left + 100 * scale)}" y="${n(barY)}" width="${n(100 * scale)}" height="6" fill="#c8c3b9"/>`);
  out.push(`<text x="${n(PAD.left)}" y="${n(barY + 22)}" class="scaletext">0</text>`);
  out.push(`<text x="${n(PAD.left + 200 * scale + 12)}" y="${n(barY + 22)}" class="scaletext" style="text-anchor:start">200 мм · сетка 50 мм · масштаб ${n(scale * 100) / 100} px/мм</text>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHEET_W}" height="${n(H)}" viewBox="0 0 ${SHEET_W} ${n(H)}">
<style>${STYLE}</style>
<rect class="bg" width="${SHEET_W}" height="${n(H)}"/>
<text x="${PAD.left}" y="40" class="slot">${esc(def.slot)}</text>
<text x="${PAD.left}" y="70" class="code">${esc(def.code)}</text>
<text x="${PAD.left + def.code.length * 15 + 16}" y="70" class="title">${esc(def.title)}</text>
<text x="${PAD.left}" y="94" class="subtitle">${esc(def.sub)}</text>
${out.join('\n')}
${notes}
</svg>
`;
}

mkdirSync(OUT, { recursive: true });
for (const def of WEAPONS) {
  writeFileSync(join(OUT, `${def.id}.svg`), sheet(def));
}

// An index page so the sheets can be flipped through on the published site.
const cards = WEAPONS.map((w) => `    <figure>
      <figcaption><b>${esc(w.code)}</b> — ${esc(w.title)}
        <a href="weapons/${w.id}.png" download>PNG для Blender</a><span>${esc(w.slot)}</span></figcaption>
      <img src="weapons/${w.id}.svg" alt="${esc(w.title)}" loading="lazy">
    </figure>`).join('\n');

writeFileSync(join(ROOT, 'docs/weapons.html'), `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GameForUs — чертежи оружия</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; padding: 24px 16px 48px; background: #f7f5f1; color: #22242a;
         font: 16px/1.6 system-ui, sans-serif; }
  main { max-width: 1240px; margin: 0 auto; }
  h1 { font-size: 32px; line-height: 1.3; margin: 0 0 8px; }
  p.lead { font-size: 16px; color: #4d4a45; margin: 0 0 32px; max-width: 66ch; }
  figure { margin: 0 0 32px; background: #fff; border: 1px solid #e4e0d8; border-radius: 8px;
           overflow: hidden; }
  figcaption { padding: 16px; font-size: 16px; border-bottom: 1px solid #e4e0d8;
               display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
  figcaption b { font-family: ui-monospace, monospace; color: #c8531f; }
  figcaption a { font-size: 14px; }
  figcaption span { margin-left: auto; font-family: ui-monospace, monospace; font-size: 14px;
                    color: #8d8880; }
  img { display: block; width: 100%; height: auto; }
  a { color: #a8451a; }
</style>
</head>
<body>
<main>
  <h1>Чертежи оружия</h1>
  <p class="lead">Боковой профиль каждого ствола в миллиметрах: ось канала ствола как база,
    сетка 50 мм, размерные линии и подписи деталей. Названия рабочие, ничьих торговых марок
    на листах нет. Прицел показан установленным, но он съёмный — планка размечена отдельно.</p>
${cards}
  <p><a href="../index.html">← к игре</a></p>
</main>
</body>
</html>
`);

console.log(`docs/weapons/*.svg — ${WEAPONS.length} sheets, plus docs/weapons.html`);
