#!/usr/bin/env node
'use strict';
// bftport — интерактивный менеджер kubectl port-forward. Без зависимостей, база — ~/.bftport/services.json.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync, execFile, execFileSync } = require('child_process');

const DB_DIR = path.join(require('os').homedir(), '.bftport');
const DB_FILE = path.join(DB_DIR, 'services.json');
// первый запуск: берём стартовый набор из пакета (seed.json), если он есть
if (!fs.existsSync(DB_FILE)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
  const seed = path.join(__dirname, 'seed.json');
  if (fs.existsSync(seed)) fs.copyFileSync(seed, DB_FILE);
}
const LOG_MAX = 300;
const VERSION = require('./package.json').version;

// ───────────────────────── база ─────────────────────────
let db = loadDb();

function loadDb() {
  try {
    const d = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    let dirty = false;
    d.services = (d.services || []).map(s => { if (s.id) return s; dirty = true; return { id: uid(), ...s }; });
    // шаблоны (группы) ссылаются на сервисы по id
    d.groups = (d.groups || []).map(g => ({ id: g.id || uid(), name: g.name, services: (g.services || []).filter(id => d.services.some(s => s.id === id)) }));
    if (!d.kubeconfigDir && d.kubeconfig) d.kubeconfigDir = path.dirname(d.kubeconfig);
    if (dirty) writeDb(d);
    return d;
  } catch (e) {
    return { kubeconfig: '', kubeconfigDir: '', services: [], groups: [] };
  }
}
function writeDb(d) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}
function saveDb() { writeDb(db); }
function uid() { return Math.random().toString(36).slice(2, 10); }

// ───────────────────────── процессы ─────────────────────────
const runtime = new Map(); // id -> { status, info, proc, want, retries, timer, log[] }
function rt(s) {
  let r = runtime.get(s.id);
  if (!r) runtime.set(s.id, r = { status: 'stopped', info: '', proc: null, want: false, retries: 0, timer: null, log: [] });
  return r;
}
function say(r, text, sys) {
  const t = new Date().toTimeString().slice(0, 8);
  r.log.push({ t, text, sys: !!sys });
  if (r.log.length > LOG_MAX) r.log.shift();
}
function portFree(port) {
  return new Promise(res => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.once('listening', () => srv.close(() => res(true)));
    srv.listen(port, '0.0.0.0');
  });
}
function kubeconfigOf(s) { return s.kubeconfig || db.kubeconfig; }

function start(s) {
  const r = rt(s);
  r.want = true;
  if (r.proc || r.timer) return;
  r.retries = 0;
  launch(s);
}
async function launch(s) {
  const r = rt(s);
  r.status = 'starting'; r.info = '';
  draw();
  if (!(await portFree(Number(s.localPort)))) {
    r.status = 'error'; r.want = false; r.info = `порт ${s.localPort} занят`;
    say(r, r.info, true); draw(); return;
  }
  if (!r.want) { r.status = 'stopped'; draw(); return; }
  const args = ['-n', s.namespace, 'port-forward', '--address', '0.0.0.0',
    `service/${s.service}`, `${s.localPort}:${s.remotePort}`];
  const kc = kubeconfigOf(s);
  if (kc) args.push('--kubeconfig=' + kc);
  say(r, '▶ kubectl ' + args.join(' '), true);
  let p;
  try { p = spawn('kubectl', args, { windowsHide: true }); }
  catch (e) { r.status = 'error'; r.info = e.message; r.want = false; draw(); return; }
  r.proc = p;
  const onData = d => {
    for (const line of d.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      say(r, line);
      if (/Forwarding from/.test(line)) {
        r.status = 'running'; r.retries = 0; r.info = `0.0.0.0:${s.localPort} → ${s.remotePort}`;
      } else if (/^error|unable to|an error occurred|lost connection/i.test(line)) {
        r.info = line.slice(0, 200);
      }
    }
    draw();
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('error', e => { r.info = e.code === 'ENOENT' ? 'kubectl не найден в PATH' : e.message; say(r, r.info, true); });
  p.on('exit', code => {
    r.proc = null;
    if (r.want) {
      r.retries++;
      const delay = r.quick ? 300 : Math.min(2000 * r.retries, 15000);
      r.quick = false;
      r.status = 'restarting';
      r.info = `упал (код ${code}), рестарт через ${Math.round(delay / 1000 * 10) / 10}с · ${r.info}`.slice(0, 200);
      say(r, '↻ ' + r.info, true);
      r.timer = setTimeout(() => { r.timer = null; if (r.want) launch(s); else { r.status = 'stopped'; draw(); } }, delay);
    } else {
      r.status = r.status === 'error' ? 'error' : 'stopped';
      say(r, '■ остановлен', true);
    }
    draw();
  });
}
function stop(s) {
  const r = rt(s);
  r.want = false;
  if (r.timer) { clearTimeout(r.timer); r.timer = null; }
  if (r.proc) { r.status = 'stopped'; r.info = ''; try { r.proc.kill(); } catch (_) {} }
  else if (r.status !== 'error') { r.status = 'stopped'; r.info = ''; }
}
function restartNow(s) {
  const r = rt(s);
  if (!r.want) return;
  if (r.proc) { r.quick = true; try { r.proc.kill(); } catch (_) {} }
}
const isActive = s => { const r = rt(s); return r.want || !!r.proc; };
function killAll() { for (const s of db.services) { const r = rt(s); r.want = false; if (r.proc) try { r.proc.kill(); } catch (_) {} } }

function kube(kc, args) {
  return new Promise((resolve, reject) => {
    const a = [...args];
    if (kc) a.push('--kubeconfig=' + kc);
    execFile('kubectl', a, { windowsHide: true, maxBuffer: 32 << 20, timeout: 30000 }, (err, out, errOut) => {
      if (err) return reject(new Error((errOut || err.message).trim().split('\n')[0]));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

// ───────────────────────── UI-состояние ─────────────────────────
const ui = {
  mode: 'list',        // list | form | picker | confirm
  sel: 0, off: 0,
  form: null, picker: null, confirm: null,
  tab: 'all',          // all | running
  gsel: 0, goff: 0,    // выбранный шаблон на вкладке «Шаблоны»
  query: '', searching: false,
  lastClick: { id: null, t: 0 },
  flash: '',
};
let W = 80, H = 24, hits = [];

const LAT = { 'й': 'q', 'ф': 'a', 'у': 'e', 'в': 'd', 'ы': 's', 'ч': 'x', 'л': 'k', 'н': 'y', 'т': 'n', 'ш': 'i', 'п': 'g' };

// стили
const RS = '\x1b[0m';
const C = {
  title: '\x1b[1;97;48;5;25m', head: '\x1b[1;38;5;245;48;5;236m', sel: '\x1b[48;5;238m',
  dim: '\x1b[38;5;245m', key: '\x1b[1;30;48;5;179m', btn: '\x1b[97;48;5;237m',
  green: '\x1b[1;38;5;78m', red: '\x1b[1;38;5;203m', yellow: '\x1b[1;38;5;221m', gray: '\x1b[38;5;243m',
  input: '\x1b[97;48;5;236m', inputF: '\x1b[1;97;48;5;24m', bold: '\x1b[1m', sys: '\x1b[38;5;110m',
  danger: '\x1b[1;97;48;5;124m',
};
const STATUS = {
  running: ['●', C.green, 'работает'], starting: ['◐', C.yellow, 'запуск…'], restarting: ['↻', C.yellow, 'рестарт'],
  error: ['✖', C.red, 'ошибка'], stopped: ['○', C.gray, 'стоп'],
};

class Row {
  constructor(y) { this.y = y; this.x = 0; this.out = ''; }
  add(text, style = '', fn) {
    text = String(text);
    if (this.x >= W) return this;
    if (this.x + text.length > W) text = text.slice(0, W - this.x);
    if (fn) hits.push({ y: this.y, x1: this.x, x2: this.x + text.length - 1, fn });
    this.out += style + text + RS;
    this.x += text.length;
    return this;
  }
  fill(style = '') { if (this.x < W) this.add(' '.repeat(W - this.x), style); return this; }
}
const trunc = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s.padEnd(n); };

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  setImmediate(() => { drawQueued = false; render(); });
}
function render() {
  W = process.stdout.columns || 80; H = process.stdout.rows || 24;
  hits = [];
  let rows;
  if (ui.mode === 'form') rows = renderForm();
  else if (ui.mode === 'picker') rows = renderPicker();
  else rows = renderList();
  let out = '\x1b[?25l';
  for (let i = 0; i < H; i++) out += `\x1b[${i + 1};1H` + (rows[i] ? rows[i].out : ' '.repeat(W));
  process.stdout.write(out);
}

function buttonRows(y, buttons) {
  // раскладывает кнопки по строкам; возвращает массив Row
  const rows = [new Row(y)];
  for (const b of buttons) {
    let r = rows[rows.length - 1];
    const w = b.key.length + b.label.length + 4;
    if (r.x + w > W && r.x > 0) { r = new Row(y + rows.length); rows.push(r); }
    r.add(' ' + b.key + ' ', C.key, b.fn).add(' ' + b.label + ' ', C.btn, b.fn).add(' ');
  }
  return rows;
}

// полнотекстовый поиск: все слова запроса должны встретиться в метаданных сервиса
function matchKind(s) {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 'meta';
  const r = rt(s);
  const meta = [s.name, s.namespace, s.service, s.localPort, s.remotePort, s.kubeconfig, STATUS[r.status][2], r.info].join(' ').toLowerCase();
  return terms.every(t => meta.includes(t)) ? 'meta' : null;
}
function visible() {
  return db.services.filter(s => (ui.tab === 'all' || isActive(s)) && matchKind(s));
}
const curSvc = () => visible()[ui.sel];

// шаблоны: набор сервисов, запускаемый одним нажатием
const members = g => g.services.map(id => db.services.find(s => s.id === id)).filter(Boolean);
function groupsVisible() {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  return db.groups.filter(g => {
    const hay = (g.name + ' ' + members(g).map(s => s.name).join(' ')).toLowerCase();
    return terms.every(t => hay.includes(t));
  });
}
const curGroup = () => groupsVisible()[ui.gsel];
function groupStat(g) {
  const m = members(g);
  return { m, act: m.filter(isActive).length, run: m.filter(s => rt(s).status === 'running').length, err: m.some(s => rt(s).status === 'error') };
}
function toggleGroup(g) {
  if (!g) return;
  const { m, act } = groupStat(g);
  if (m.length && act === m.length) m.forEach(stop); else m.filter(s => !isActive(s)).forEach(start);
  draw();
}
function onGroupClick(idx) {
  const g = groupsVisible()[idx], now = Date.now();
  if (ui.lastClick.id === g.id && now - ui.lastClick.t < 450) { ui.gsel = idx; toggleGroup(g); ui.lastClick = { id: null, t: 0 }; }
  else { ui.gsel = idx; ui.lastClick = { id: g.id, t: now }; }
  draw();
}
function askDeleteGroup() {
  const g = curGroup(); if (!g) return;
  ui.mode = 'confirm';
  ui.confirm = { msg: `Удалить шаблон «${g.name}»? (сервисы останутся)`, yes: () => { db.groups.splice(db.groups.indexOf(g), 1); saveDb(); closeConfirm(); } };
  draw();
}

function renderGroups(rows) {
  const gs = groupsVisible();
  const nameW = Math.max(12, Math.min(26, Math.floor(W * 0.22)));
  const h = new Row(2);
  h.add(' ', C.head).add('  ' + trunc('ШАБЛОН', nameW) + ' ', C.head).add(trunc('СТАТУС', 16) + ' ', C.head).add('СОСТАВ', C.head).fill(C.head);
  rows.push(h);
  const logH = Math.max(3, Math.min(10, Math.floor(H * 0.3)));
  const listH = Math.max(3, H - 6 - logH);
  if (ui.gsel >= gs.length) ui.gsel = Math.max(0, gs.length - 1);
  if (ui.gsel < ui.goff) ui.goff = ui.gsel;
  if (ui.gsel >= ui.goff + listH) ui.goff = ui.gsel - listH + 1;
  for (let i = 0; i < listH; i++) {
    const row = new Row(3 + i), g = gs[ui.goff + i];
    if (!g) {
      if (!gs.length && i === 1) {
        if (!db.groups.length) row.add('  Шаблонов нет. ', C.dim).add(' A ', C.key, () => openGroupForm()).add(' создать вручную или ', C.dim).add(' G ', C.key, () => saveRunningAsGroup()).add(' на вкладке «Все» — сохранить запущенные', C.dim);
        else row.add('  Ничего не найдено по запросу', C.dim);
      }
      row.fill(); rows.push(row); continue;
    }
    const idx = ui.goff + i, bg = idx === ui.gsel ? C.sel : '', click = () => onGroupClick(idx);
    const st = groupStat(g);
    const [icon, col] = !st.m.length ? ['○', C.gray] : st.err ? ['✖', C.red] : st.run === st.m.length ? ['●', C.green] : st.act ? ['◐', C.yellow] : ['○', C.gray];
    row.add(idx === ui.gsel ? '▌' : ' ', C.yellow + bg, click).add(' ' + icon + ' ', col + bg, click)
      .add(trunc(g.name, nameW) + ' ', C.bold + bg, click)
      .add(trunc(`${st.run}/${st.m.length} работает`, 16) + ' ', col + bg, click)
      .add(trunc(st.m.map(s => s.name).join(', '), W - row.x), C.dim + bg, click);
    row.fill(bg); rows.push(row);
  }
  const cur = gs[ui.gsel];
  rows.push(new Row(3 + listH).add(' Состав' + (cur ? ': ' + cur.name : '') + ' ', C.head).fill(C.head));
  const ms = cur ? members(cur) : [];
  for (let i = 0; i < logH; i++) {
    const row = new Row(4 + listH + i), s = ms[i];
    if (s) { const st = STATUS[rt(s).status]; row.add(' ' + st[0] + ' ', st[1]).add(trunc(s.name, 28) + ' ').add(trunc(`${s.namespace}/${s.service}`, 38) + ' ', C.dim).add(`:${s.localPort}  ${st[2]}`, C.gray); }
    row.fill(); rows.push(row);
  }
  const st = cur ? groupStat(cur) : null;
  const allOn = st && st.m.length && st.act === st.m.length;
  const btns = [
    { key: 'Enter', label: allOn ? 'Остановить набор' : 'Запустить набор', fn: () => toggleGroup(curGroup()) },
    { key: 'A', label: 'Создать', fn: () => openGroupForm() },
    { key: 'E', label: 'Изменить', fn: () => cur && openGroupForm(cur) },
    { key: 'D', label: 'Удалить', fn: () => askDeleteGroup() },
    { key: '/', label: 'Поиск', fn: () => { ui.searching = true; draw(); } },
    { key: 'K', label: 'Конфиг', fn: () => switchKubeconfig() },
    { key: 'Q', label: 'Выход', fn: () => quit() },
  ];
  for (const r of buttonRows(4 + listH + logH, btns)) { r.fill(); rows.push(r); }
  if (ui.mode === 'confirm') return confirmOverlay(rows);
  return rows;
}

function saveRunningAsGroup() { openGroupForm(null, db.services.filter(isActive).map(s => s.id)); }
function openGroupForm(g, preset) {
  const f = {
    title: g ? `Шаблон: ${g.name}` : 'Новый шаблон', focus: 0, err: '',
    chosen: new Set(g ? g.services : (preset || [])),
    fields: [{ key: 'name', label: 'Название', value: g ? g.name : '' }],
    buttons: [
      { key: 'Enter', label: 'Сохранить', fn: () => submitGroup(f, g) },
      { key: 'F2', label: 'Выбрать сервисы', fn: () => chooseMembers(f) },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
  };
  f.info = () => {
    const names = db.services.filter(s => f.chosen.has(s.id)).map(s => s.name);
    return names.length ? `Сервисы (${names.length}): ${names.join(', ')}` : 'Сервисы не выбраны — нажмите F2';
  };
  openForm(f);
}
async function chooseMembers(f) {
  const items = db.services.map(s => ({ label: `${s.name.padEnd(26)} ${s.namespace}/${s.service}  :${s.localPort}`, value: s.id }));
  const res = await pick('Сервисы шаблона', items, { multi: true, checked: new Set(f.chosen) });
  if (res) f.chosen = new Set(res);
  draw();
}
function submitGroup(f, g) {
  const name = String(fval(f, 'name')).trim();
  if (!name) return fail(f, 'Введите название шаблона');
  if (!f.chosen.size) return fail(f, 'Выберите хотя бы один сервис (F2)');
  if (db.groups.some(x => x !== g && x.name.toLowerCase() === name.toLowerCase())) return fail(f, 'Шаблон с таким названием уже есть');
  const ids = db.services.filter(s => f.chosen.has(s.id)).map(s => s.id);
  if (g) { g.name = name; g.services = ids; }
  else { db.groups.push({ id: uid(), name, services: ids }); ui.gsel = db.groups.length - 1; }
  ui.tab = 'groups'; ui.query = '';
  saveDb(); closeForm();
}

function renderList() {
  const rows = [];
  const isG = ui.tab === 'groups';
  const svcs = isG ? [] : visible();
  const running = db.services.filter(s => rt(s).status === 'running').length;
  const activeN = db.services.filter(isActive).length;
  const t = new Row(0);
  t.add(` ⇄ Port Forwards v${VERSION} `, C.title).add(` ${db.services.length} сервисов · ${running} работает `, C.title);
  const kc = db.kubeconfig ? '⎈ ' + path.basename(db.kubeconfig) + ' ▾' : 'kubeconfig не выбран (K)';
  const right = ` ${kc} `;
  if (W - t.x > right.length) t.add(' '.repeat(W - t.x - right.length), C.title).add(right, C.title, () => switchKubeconfig());
  t.fill(C.title); rows.push(t);

  const tb = new Row(1);
  const tab = (id, label) => tb.add(` ${label} `, ui.tab === id ? C.key : C.btn, () => { ui.tab = id; ui.sel = 0; ui.off = 0; ui.gsel = 0; ui.goff = 0; draw(); }).add(' ');
  tb.add(' ');
  tab('all', `1 Все (${db.services.length})`); tab('running', `2 Запущенные (${activeN})`); tab('groups', `3 Шаблоны (${db.groups.length})`);
  tb.add('  ');
  const qShown = ui.query + (ui.searching ? '▌' : '');
  tb.add(' ⌕ ', ui.searching ? C.inputF : C.input, () => { ui.searching = true; draw(); });
  const boxW = Math.max(10, Math.min(40, W - tb.x - 12));
  tb.add(trunc(ui.query || ui.searching ? qShown : 'поиск: / или Ctrl+F', boxW) + ' ', ui.searching ? C.inputF : (ui.query ? C.input : C.input + C.gray), () => { ui.searching = true; draw(); });
  if (ui.query) tb.add(' ✕ ', C.btn, () => { ui.query = ''; ui.searching = false; ui.sel = 0; ui.gsel = 0; draw(); });
  if (ui.query) tb.add(` найдено: ${isG ? groupsVisible().length : svcs.length}`, C.dim);
  tb.fill(); rows.push(tb);
  if (isG) return renderGroups(rows);

  const nameW = Math.max(12, Math.min(26, Math.floor(W * 0.22)));
  const targetW = Math.max(16, Math.min(40, Math.floor(W * 0.33)));
  const h = new Row(2);
  h.add(' ', C.head).add('  ' + trunc('СЕРВИС', nameW) + ' ', C.head).add(trunc('NS / SERVICE', targetW) + ' ', C.head)
    .add(trunc('ПОРТ', 14) + ' ', C.head).add('СТАТУС', C.head).fill(C.head);
  rows.push(h);

  const logH = Math.max(3, Math.min(10, Math.floor(H * 0.3)));
  const listH = Math.max(3, H - 6 - logH);
  if (ui.sel >= svcs.length) ui.sel = Math.max(0, svcs.length - 1);
  if (ui.sel < ui.off) ui.off = ui.sel;
  if (ui.sel >= ui.off + listH) ui.off = ui.sel - listH + 1;

  for (let i = 0; i < listH; i++) {
    const y = 3 + i, row = new Row(y), s = svcs[ui.off + i];
    if (!s) {
      if (!svcs.length && i === 1) {
        if (!db.services.length) row.add('  Пока пусто. Нажмите ', C.dim).add(' A ', C.key, () => openServiceForm()).add(' чтобы добавить сервис', C.dim);
        else row.add(ui.query ? '  Ничего не найдено по запросу' : '  Нет запущенных сервисов — выберите вкладку «Все» и нажмите Enter', C.dim);
      }
      row.fill(); rows.push(row); continue;
    }
    const idx = ui.off + i, r = rt(s), st = STATUS[r.status];
    const bg = idx === ui.sel ? C.sel : '';
    const click = () => onRowClick(idx);
    row.add(idx === ui.sel ? '▌' : ' ', C.yellow + bg, click)
      .add(' ' + st[0] + ' ', st[1] + bg, click)
      .add(trunc(s.name, nameW) + ' ', C.bold + bg, click)
      .add(trunc(`${s.namespace}/${s.service}`, targetW) + ' ', C.dim + bg, click)
      .add(trunc(`${s.localPort}:${s.remotePort}`, 14) + ' ', bg, click);
    const left = W - row.x;
    const detail = r.status === 'running' || r.status === 'stopped' && !r.info ? st[2] + (s.autostart ? ' · авто' : '') : `${st[2]} · ${r.info}`;
    row.add(trunc(detail, left), (r.status === 'error' ? C.red : r.status === 'running' ? C.green : C.gray) + bg, click);
    row.fill(bg); rows.push(row);
  }

  const cur = svcs[ui.sel];
  const sep = new Row(3 + listH);
  sep.add(' Логи' + (cur ? ': ' + cur.name : '') + ' ', C.head).fill(C.head); rows.push(sep);
  const log = cur ? rt(cur).log : [];
  const shown = log.slice(-logH);
  for (let i = 0; i < logH; i++) {
    const row = new Row(4 + listH + i), l = shown[i];
    if (l) row.add(' ' + l.t + ' ', C.gray).add(l.text, l.sys ? C.sys : '');
    row.fill(); rows.push(row);
  }

  const fy = 4 + listH + logH;
  const btns = [
    { key: 'Enter', label: cur && isActive(cur) ? 'Стоп' : 'Старт', fn: () => toggle() },
    { key: 'A', label: 'Добавить', fn: () => openServiceForm() },
    { key: 'E', label: 'Изменить', fn: () => cur && openServiceForm(cur) },
    { key: 'D', label: 'Удалить', fn: () => askDelete() },
    { key: 'S', label: 'Старт все', fn: () => { visible().forEach(start); } },
    { key: 'X', label: 'Стоп все', fn: () => { visible().forEach(stop); draw(); } },
    { key: 'G', label: 'В шаблон', fn: () => saveRunningAsGroup() },
    { key: '/', label: 'Поиск', fn: () => { ui.searching = true; draw(); } },
    { key: 'K', label: 'Конфиг', fn: () => switchKubeconfig() },
    { key: 'Q', label: 'Выход', fn: () => quit() },
  ];
  const br = buttonRows(fy, btns);
  for (const r of br) { r.fill(); rows.push(r); }
  if (ui.mode === 'confirm') return confirmOverlay(rows);
  return rows;
}

function confirmOverlay(rows) {
  const c = ui.confirm;
  const y = Math.max(2, Math.floor(H / 3));
  const box = new Row(y);
  const msg = ' ' + c.msg + ' ';
  hits = [];
  box.add(msg, C.danger).fill(C.danger);
  rows[y] = box;
  const b = new Row(y + 1);
  b.add(' Y ', C.key, () => c.yes()).add(' Да ', C.btn, () => c.yes()).add(' ')
    .add(' N ', C.key, () => closeConfirm()).add(' Нет ', C.btn, () => closeConfirm()).fill();
  rows[y + 1] = b;
  return rows;
}

// ───────────────────────── действия ─────────────────────────
function onRowClick(idx) {
  const s = visible()[idx];
  const now = Date.now();
  if (ui.lastClick.id === s.id && now - ui.lastClick.t < 450) { ui.sel = idx; toggle(); ui.lastClick = { id: null, t: 0 }; }
  else { ui.sel = idx; ui.lastClick = { id: s.id, t: now }; }
  draw();
}
function toggle() {
  const s = curSvc(); if (!s) return;
  if (isActive(s)) stop(s); else start(s);
  draw();
}
function askDelete() {
  const s = curSvc(); if (!s) return;
  ui.mode = 'confirm';
  ui.confirm = { msg: `Удалить «${s.name}»?`, yes: () => { stop(s); db.services.splice(db.services.indexOf(s), 1); db.groups.forEach(g => { g.services = g.services.filter(id => id !== s.id); }); saveDb(); closeConfirm(); } };
  draw();
}
function askQuit() {
  const n = db.services.filter(isActive).length;
  ui.mode = 'confirm';
  ui.confirm = { msg: `Остановить ${n} проброс(ов) и выйти?`, yes: () => exit() };
  draw();
}
function quit() { db.services.some(isActive) ? askQuit() : exit(); }
function closeConfirm() { ui.mode = 'list'; ui.confirm = null; draw(); }
function exit() {
  killAll();
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l');
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.exit(0);
}

// ───────────────────────── форма ─────────────────────────
function openForm(f) { ui.form = f; ui.mode = 'form'; draw(); }
function closeForm() { ui.form = null; ui.mode = 'list'; draw(); }
const fval = (f, k) => f.fields.find(x => x.key === k).value;
const fset = (f, k, v) => { f.fields.find(x => x.key === k).value = v; };

function openServiceForm(s) {
  const isNew = !s;
  const last = db.services[db.services.length - 1];
  const f = {
    title: isNew ? 'Новый сервис' : `Изменить: ${s.name}`,
    focus: 0, err: '',
    fields: [
      { key: 'name', label: 'Имя', value: s ? s.name : '' },
      { key: 'namespace', label: 'Namespace', value: s ? s.namespace : (last ? last.namespace : '') },
      { key: 'service', label: 'Service', value: s ? s.service : '' },
      { key: 'localPort', label: 'Локальный порт', value: s ? String(s.localPort) : '', digits: true },
      { key: 'remotePort', label: 'Порт сервиса', value: s ? String(s.remotePort) : 'grpc', hint: 'имя порта (grpc) или номер' },
      { key: 'kubeconfig', label: 'Kubeconfig', value: s ? (s.kubeconfig || '') : '', hint: 'пусто = общий' },
      { key: 'autostart', label: 'Автозапуск', value: s ? !!s.autostart : false, bool: true },
    ],
    buttons: [
      { key: 'Enter', label: 'Сохранить', fn: () => submitService(f, s) },
      { key: 'F2', label: 'Выбрать из кластера', fn: () => discover(f) },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
  };
  openForm(f);
}
function submitService(f, s) {
  const v = k => String(fval(f, k)).trim();
  const lp = Number(v('localPort'));
  if (!v('name') || !v('namespace') || !v('service') || !v('remotePort')) return fail(f, 'Заполните имя, namespace, service и порт сервиса');
  if (!(lp >= 1 && lp <= 65535)) return fail(f, 'Локальный порт: число 1–65535');
  const dup = db.services.find(x => x !== s && Number(x.localPort) === lp);
  if (dup) return fail(f, `Порт ${lp} уже занят сервисом «${dup.name}»`);
  const data = {
    name: v('name'), namespace: v('namespace'), service: v('service'), localPort: lp,
    remotePort: v('remotePort'), kubeconfig: v('kubeconfig'), autostart: !!fval(f, 'autostart'),
  };
  if (s) {
    Object.assign(s, data); restartNow(s);
  } else {
    const ns = { id: uid(), ...data }; db.services.push(ns); ui.tab = 'all'; ui.query = ''; ui.sel = db.services.length - 1;
  }
  saveDb(); closeForm();
}
function fail(f, msg) { f.err = msg; draw(); }

// kubeconfig: настраивается папка с конфигами, а конфиг выбирается из неё одним списком (K)
const PICK_FOLDER = { folder: true };
const sameFile = (a, b) => !!a && !!b && (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
const expandHome = p => p.replace(/^~(?=$|[\\/])/, require('os').homedir());

function listKubeconfigs(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && !e.name.startsWith('.'))
    .map(e => e.name).sort((x, y) => x.localeCompare(y))
    .map(name => {
      const full = path.join(dir, name);
      return { label: (sameFile(full, db.kubeconfig) ? '● ' : '  ') + name, value: full };
    });
}
async function switchKubeconfig() {
  const dir = db.kubeconfigDir;
  if (!dir || !fs.existsSync(dir)) return openKubeDirForm();
  const res = await pick(`Kubeconfig — ${dir}`, Promise.resolve().then(() => listKubeconfigs(dir)), { f2: 'Папка с конфигами', current: db.kubeconfig });
  if (res === PICK_FOLDER) return openKubeDirForm();
  if (res) applyKubeconfig(res);
}
function applyKubeconfig(file) {
  if (sameFile(file, db.kubeconfig)) return;
  const apply = () => { db.kubeconfig = file; saveDb(); };
  // пробросы привязаны к кластеру, поэтому при смене конфига останавливаем те, что используют общий
  const act = db.services.filter(s => isActive(s) && !s.kubeconfig);
  if (!act.length) { apply(); return draw(); }
  ui.mode = 'confirm';
  ui.confirm = { msg: `Переключить на «${path.basename(file)}»? Будет остановлено пробросов: ${act.length}`, yes: () => { act.forEach(stop); apply(); closeConfirm(); } };
  draw();
}
function openKubeDirForm() {
  const f = {
    title: 'Папка с kubeconfig-файлами', focus: 0, err: '',
    fields: [{ key: 'dir', label: 'Путь к папке', value: db.kubeconfigDir || '', hint: 'например C:\\Users\\me\\kube' }],
    buttons: [
      { key: 'Enter', label: 'Сохранить', fn: () => {
        const dir = path.resolve(expandHome(String(fval(f, 'dir')).trim().replace(/^"|"$/g, '')));
        if (!String(fval(f, 'dir')).trim()) return fail(f, 'Укажите путь к папке');
        let ok = false;
        try { ok = fs.statSync(dir).isDirectory(); } catch (_) {}
        if (!ok) return fail(f, 'Такой папки нет: ' + dir);
        db.kubeconfigDir = dir; saveDb(); closeForm(); switchKubeconfig();
      } },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
    submit: () => f.buttons[0].fn(),
  };
  f.info = () => 'После сохранения откроется список конфигов из этой папки';
  openForm(f);
}

function renderForm() {
  const f = ui.form, rows = [];
  rows.push(new Row(0).add(' ' + f.title + ' ', C.title).fill(C.title));
  rows.push(new Row(1).fill());
  const labelW = 18, boxW = Math.max(20, Math.min(64, W - labelW - 6));
  f.fields.forEach((fl, i) => {
    const y = 2 + i, r = new Row(y), focus = i === f.focus;
    const focusFn = () => { f.focus = i; if (fl.bool) fl.value = !fl.value; draw(); };
    r.add('  ').add(trunc(fl.label, labelW), focus ? C.yellow : C.dim, focusFn);
    if (fl.bool) {
      r.add(fl.value ? ' [x] ' : ' [ ] ', focus ? C.inputF : C.input, focusFn);
    } else {
      let txt = String(fl.value);
      const shown = txt.length > boxW - 2 ? '…' + txt.slice(-(boxW - 3)) : txt;
      let body = shown + (focus ? '▌' : '');
      if (!txt && !focus && fl.hint) { r.add((' ' + fl.hint).padEnd(boxW), C.input + C.gray, focusFn); }
      else r.add((' ' + body).padEnd(boxW), focus ? C.inputF : C.input, focusFn);
      if (focus && !txt && fl.hint) r.add(' ' + fl.hint, C.gray);
    }
    r.fill(); rows.push(r);
  });
  const y0 = 2 + f.fields.length;
  rows.push(new Row(y0).add('  ' + (f.info ? f.info() : ''), C.sys).fill());
  rows.push(new Row(y0 + 1).add('  ' + f.err, C.red).fill());
  for (const r of buttonRows(y0 + 2, f.buttons)) { r.fill(); rows.push(r); }
  rows.push(new Row(y0 + 4).add('  Tab/↑↓ — поля · Пробел — переключить галочку · Ctrl+U — очистить поле', C.gray).fill());
  return rows;
}

function formKey(e) {
  const f = ui.form, fl = f.fields[f.focus];
  const n = f.fields.length;
  switch (e.k) {
    case 'esc': return closeForm();
    case 'tab': case 'down': f.focus = (f.focus + 1) % n; break;
    case 'stab': case 'up': f.focus = (f.focus + n - 1) % n; break;
    case 'enter': return f.submit ? f.submit() : f.buttons[0].fn();
    case 'f2': if (f.buttons[1] && f.buttons[1].key === 'F2') return f.buttons[1].fn(); break;
    case 'bs': if (!fl.bool) fl.value = String(fl.value).slice(0, -1); break;
    case 'ctrl-u': if (!fl.bool) fl.value = ''; break;
    case 'space': if (fl.bool) { fl.value = !fl.value; break; } // иначе — обычный символ
    // fallthrough
    case 'char': {
      if (fl.bool) break;
      const ch = e.k === 'space' ? ' ' : e.ch;
      if (fl.digits && !/\d/.test(ch)) break;
      fl.value += ch; break;
    }
    case 'ctrl-c': return quit();
  }
  f.err = '';
  draw();
}

// ───────────────────────── обзор кластера ─────────────────────────
function pick(title, loader, opts = {}) {
  return new Promise(resolve => {
    const prev = ui.mode;
    const p = ui.picker = { title, f2: opts.f2, multi: !!opts.multi, checked: opts.checked || new Set(), items: null, err: '', filter: '', sel: 0, off: 0, done: v => { ui.picker = null; ui.mode = prev; draw(); resolve(v); } };
    ui.mode = 'picker'; draw();
    Promise.resolve(loader).then(items => { p.items = items; if (opts.current !== undefined) { const i = items.findIndex(x => x.value === opts.current || sameFile(x.value, opts.current)); if (i >= 0) p.sel = i; } draw(); }, err => { p.err = err.message; draw(); });
  });
}
function filtered(p) {
  const q = p.filter.toLowerCase();
  return (p.items || []).filter(i => i.label.toLowerCase().includes(q));
}
function renderPicker() {
  const p = ui.picker, rows = [];
  rows.push(new Row(0).add(' ' + p.title + ' ', C.title).fill(C.title));
  rows.push(new Row(1).add('  Фильтр: ', C.dim).add(p.filter + '▌', C.bold).fill());
  const listH = Math.max(3, H - 4);
  if (p.err) rows.push(new Row(2).add('  ' + p.err, C.red).fill());
  else if (!p.items) rows.push(new Row(2).add('  Загрузка…', C.yellow).fill());
  else if (!p.items.length) rows.push(new Row(2).add('  Список пуст', C.gray).fill());
  const items = filtered(p);
  if (p.sel >= items.length) p.sel = Math.max(0, items.length - 1);
  if (p.sel < p.off) p.off = p.sel;
  if (p.sel >= p.off + listH) p.off = p.sel - listH + 1;
  if (p.items && !p.err) {
    for (let i = 0; i < listH; i++) {
      const it = items[p.off + i], r = new Row(2 + i);
      if (it) {
        const idx = p.off + i, bg = idx === p.sel ? C.sel : '';
        const fn = () => { if (p.multi) { p.sel = idx; toggleChecked(p, it); } else if (p.sel === idx) p.done(it.value); else { p.sel = idx; draw(); } };
        r.add(idx === p.sel ? ' ▌ ' : '   ', C.yellow + bg, fn);
        if (p.multi) r.add(p.checked.has(it.value) ? '[x] ' : '[ ] ', (p.checked.has(it.value) ? C.green : C.gray) + bg, fn);
        r.add(it.label, bg, fn).fill(bg);
      } else r.fill();
      rows.push(r);
    }
  }
  while (rows.length < H - 1) rows.push(new Row(rows.length).fill());
  const b = buttonRows(H - 1, [
    ...(p.multi ? [{ key: 'Пробел', label: 'Отметить', fn: () => { const it = filtered(p)[p.sel]; if (it) toggleChecked(p, it); } }] : []),
    { key: 'Enter', label: p.multi ? `Готово (${p.checked.size})` : 'Выбрать', fn: () => { if (p.multi) return finishMulti(p); const it = filtered(p)[p.sel]; if (it) p.done(it.value); } },
    ...(p.f2 ? [{ key: 'F2', label: p.f2, fn: () => p.done(PICK_FOLDER) }] : []),
    { key: 'Esc', label: 'Назад', fn: () => p.done(null) }]);
  rows[H - 1] = b[0].fill();
  return rows;
}
function toggleChecked(p, it) { if (!p.checked.delete(it.value)) p.checked.add(it.value); draw(); }
function finishMulti(p) { p.done((p.items || []).filter(i => p.checked.has(i.value)).map(i => i.value)); }
function pickerKey(e) {
  const p = ui.picker, items = filtered(p);
  switch (e.k) {
    case 'esc': return p.done(null);
    case 'f2': if (p.f2) return p.done(PICK_FOLDER); break;
    case 'up': p.sel = Math.max(0, p.sel - 1); break;
    case 'down': p.sel = Math.min(items.length - 1, p.sel + 1); break;
    case 'pgup': p.sel = Math.max(0, p.sel - 10); break;
    case 'pgdn': p.sel = Math.min(items.length - 1, p.sel + 10); break;
    case 'enter': if (p.multi) return finishMulti(p); if (items[p.sel]) return p.done(items[p.sel].value); break;
    case 'bs': p.filter = p.filter.slice(0, -1); p.sel = 0; break;
    case 'space': if (p.multi) { if (items[p.sel]) toggleChecked(p, items[p.sel]); return; } p.filter += ' '; p.sel = 0; break;
    case 'char': p.filter += e.ch; p.sel = 0; break;
    case 'ctrl-c': return p.done(null);
  }
  draw();
}
async function discover(f) {
  const kc = String(fval(f, 'kubeconfig')).trim() || db.kubeconfig;
  if (!kc) { f.err = 'Сначала выберите kubeconfig (клавиша K в списке)'; return draw(); }
  const ns = await pick('Namespace', kube(kc, ['get', 'ns', '-o', 'json']).then(d => d.items.map(i => ({ label: i.metadata.name, value: i.metadata.name })).sort((a, b) => a.label.localeCompare(b.label))));
  if (!ns) return;
  const svc = await pick(`Service в «${ns}»`, kube(kc, ['-n', ns, 'get', 'svc', '-o', 'json']).then(d => d.items.map(i => {
    const ports = (i.spec.ports || []);
    return { label: `${i.metadata.name.padEnd(44)} ${ports.map(p => `${p.name ? p.name + ':' : ''}${p.port}`).join('  ')}`, value: { name: i.metadata.name, ports } };
  }).sort((a, b) => a.label.localeCompare(b.label))));
  if (!svc) return;
  let port = svc.ports[0];
  if (svc.ports.length > 1) {
    port = await pick(`Порт «${svc.name}»`, svc.ports.map(p => ({ label: `${p.name || '(без имени)'}  ${p.port}/${p.protocol}`, value: p })));
    if (!port) return;
  }
  fset(f, 'namespace', ns); fset(f, 'service', svc.name);
  if (!String(fval(f, 'name')).trim()) fset(f, 'name', svc.name);
  if (port) {
    fset(f, 'remotePort', port.name || String(port.port));
    if (!String(fval(f, 'localPort')).trim()) fset(f, 'localPort', String(port.port));
  }
  f.focus = 0; draw();
}

// ───────────────────────── ввод ─────────────────────────
const KEYS = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1b[H': 'home', '\x1b[F': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'del', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[Z': 'stab',
  '\x1bOQ': 'f2', '\x1b[12~': 'f2', '\x1bOA': 'up', '\x1bOB': 'down',
};
const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO[A-Z]|\x1b|[\s\S]/gu;

function onData(buf) {
  for (const m of buf.toString('utf8').matchAll(TOKEN)) {
    const t = m[0];
    if (m[1] !== undefined) { onMouse(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1, m[4] === 'M'); continue; }
    let e;
    if (KEYS[t]) e = { k: KEYS[t] };
    else if (t === '\x1b') e = { k: 'esc' };
    else if (t === '\r' || t === '\n') e = { k: 'enter' };
    else if (t === '\t') e = { k: 'tab' };
    else if (t === '\x7f' || t === '\b') e = { k: 'bs' };
    else if (t === '\x03') e = { k: 'ctrl-c' };
    else if (t === '\x15') e = { k: 'ctrl-u' };
    else if (t === '\x06') e = { k: 'ctrl-f' };
    else if (t === ' ') e = { k: 'space' };
    else if (t >= ' ' && t[0] !== '\x1b') e = { k: 'char', ch: t };
    else continue;
    onKey(e);
  }
}
function onMouse(b, x, y, press) {
  if (!press) return;
  if (b === 64 || b === 65) { // колесо
    const d = b === 64 ? 'up' : 'down';
    if (ui.mode === 'list') onKey({ k: d }); else if (ui.mode === 'picker') pickerKey({ k: d });
    return;
  }
  if (b !== 0) return;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.y === y && x >= h.x1 && x <= h.x2) { h.fn(); return; }
  }
}
function onKey(e) {
  if (ui.mode === 'form') return formKey(e);
  if (ui.mode === 'picker') return pickerKey(e);
  if (ui.mode === 'confirm') {
    const ch = e.k === 'char' ? (LAT[e.ch.toLowerCase()] || e.ch.toLowerCase()) : '';
    if (e.k === 'enter' || ch === 'y') return ui.confirm.yes();
    if (e.k === 'esc' || ch === 'n') return closeConfirm();
    return;
  }
  const isG = ui.tab === 'groups';
  const sk = isG ? 'gsel' : 'sel';
  const n = isG ? groupsVisible().length : visible().length;
  const TABS = ['all', 'running', 'groups'];
  const setTab = t => { ui.tab = t; ui.sel = 0; ui.off = 0; ui.gsel = 0; ui.goff = 0; };
  const nextTab = () => setTab(TABS[(TABS.indexOf(ui.tab) + 1) % TABS.length]);
  if (ui.searching) {
    switch (e.k) {
      case 'esc': ui.query = ''; ui.searching = false; ui[sk] = 0; break;
      case 'enter': ui.searching = false; break;
      case 'bs': if (ui.query) { ui.query = ui.query.slice(0, -1); } else ui.searching = false; ui[sk] = 0; break;
      case 'ctrl-u': ui.query = ''; ui[sk] = 0; break;
      case 'space': ui.query += ' '; ui[sk] = 0; break;
      case 'char': ui.query += e.ch; ui[sk] = 0; break;
      case 'tab': nextTab(); break;
      case 'up': ui[sk] = Math.max(0, ui[sk] - 1); break;
      case 'down': ui[sk] = Math.min(n - 1, ui[sk] + 1); break;
      case 'ctrl-c': return quit();
    }
    return draw();
  }
  const ch = e.k === 'char' ? (LAT[e.ch.toLowerCase()] || e.ch.toLowerCase()) : '';
  if (e.k === 'ctrl-c' || ch === 'q') return quit();
  switch (e.k) {
    case 'up': ui[sk] = Math.max(0, ui[sk] - 1); break;
    case 'down': ui[sk] = Math.min(n - 1, ui[sk] + 1); break;
    case 'pgup': ui[sk] = Math.max(0, ui[sk] - 8); break;
    case 'pgdn': ui[sk] = Math.min(n - 1, ui[sk] + 8); break;
    case 'home': ui[sk] = 0; break;
    case 'end': ui[sk] = Math.max(0, n - 1); break;
    case 'enter': case 'space': return isG ? toggleGroup(curGroup()) : toggle();
    case 'del': return isG ? askDeleteGroup() : askDelete();
    case 'tab': nextTab(); break;
    case 'ctrl-f': ui.searching = true; break;
    case 'esc': if (ui.query) { ui.query = ''; ui[sk] = 0; } break;
  }
  if (e.k === 'char' && e.ch === '/') ui.searching = true;
  if (e.k === 'char' && e.ch === '1') setTab('all');
  if (e.k === 'char' && e.ch === '2') setTab('running');
  if (e.k === 'char' && e.ch === '3') setTab('groups');
  if (ch === 'k') return switchKubeconfig();
  if (isG) {
    const g = curGroup();
    if (ch === 'a') return openGroupForm();
    if (ch === 'e' && g) return openGroupForm(g);
    if (ch === 'd') return askDeleteGroup();
    if (ch === 's' && g) members(g).forEach(start);
    if (ch === 'x' && g) members(g).forEach(stop);
  } else {
    const cur = curSvc();
    if (ch === 'a') return openServiceForm();
    if (ch === 'e' && cur) return openServiceForm(cur);
    if (ch === 'd') return askDelete();
    if (ch === 'g') return saveRunningAsGroup();
    if (ch === 's') visible().forEach(start);
    if (ch === 'x') visible().forEach(stop);
  }
  draw();
}

// На Windows консоль по умолчанию перехватывает мышь для выделения текста (QuickEdit) и не отдаёт
// клики приложению. Node не умеет менять эти флаги, поэтому один раз правим режим консоли через PowerShell.
function enableConsoleMouse() {
  if (process.platform !== 'win32') return;
  const ps = `$s='[DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m);';` +
    `$t=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru; $h=$t::GetStdHandle(-10); $m=[uint32]0; [void]$t::GetConsoleMode($h,[ref]$m);` +
    `[void]$t::SetConsoleMode($h, ($m -bor 0x10 -bor 0x80) -band (-bnot 0x40))`;
  try {
    spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['inherit', 'ignore', 'ignore'], windowsHide: true })
      .on('error', () => {}).unref();
  } catch (_) {}
}

// ───────────────────────── запуск ─────────────────────────
if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log('bftport v' + require('./package.json').version); process.exit(0);
}
if (process.argv.includes('--update')) {
  const pkg = require('./package.json');
  const repo = (pkg.repository && pkg.repository.url) || '';
  if (!repo) { console.error('В package.json не указан repository.url'); process.exit(1); }
  const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d > 0 ? 1 : -1; } return 0; };
  console.log(`Установлена версия ${pkg.version}. Проверяю обновления…`);
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bftport-'));
  let remote;
  try {
    execFileSync('git', ['clone', '--depth', '1', '--quiet', repo.replace(/^git\+/, ''), path.join(tmp, 'r')],
      { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout: 60000 });
    remote = JSON.parse(fs.readFileSync(path.join(tmp, 'r', 'package.json'), 'utf8')).version;
  } catch (e) {
    const why = String(e.stderr || e.message).trim().split('\n').pop();
    console.error(`Не удалось получить версию из репозитория: ${why}`);
    console.error('Проверьте доступ к репозиторию (git clone должен работать без ввода пароля) и наличие git в PATH.');
    process.exit(1);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
  const c = cmp(remote, pkg.version);
  if (c === 0) { console.log(`Установлена актуальная версия (${pkg.version}).`); process.exit(0); }
  if (c < 0) { console.log(`Установленная версия (${pkg.version}) новее, чем в репозитории (${remote}). Обновление не требуется.`); process.exit(0); }
  console.log(`Доступна версия ${remote}. Обновляю…\n`);
  const r = spawnSync('npm', ['install', '-g', repo], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('\nОбновление не удалось (код ' + r.status + ').'); process.exit(r.status || 1); }
  console.log(`\nbftport ${remote}`);
  process.exit(0);
}
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`bftport ${require('./package.json').version} — менеджер kubectl port-forward

ИСПОЛЬЗОВАНИЕ
  bftport             запустить интерфейс (нужен интерактивный терминал)
  bftport --keys      диагностика ввода: показывает клавиши и клики мыши
  bftport --update    проверить новую версию в репозитории и обновиться
  bftport --version   версия
  bftport --help      эта справка

ПЕРВЫЙ ЗАПУСК
  1. Нажмите K, укажите папку с вашими kubeconfig и выберите нужный файл.
  2. Выберите сервис и нажмите Enter, чтобы запустить проброс.
  3. Свой сервис: A. Кнопка «Выбрать из кластера» (F2) подтянет namespace,
     service и порты прямо из кластера.

КЛАВИШИ (работают и в русской раскладке; почти всё можно нажать мышью)
  ↑ ↓ / колесо / клик   выбрать             Enter / Пробел / двойной клик   старт / стоп
  A  добавить           E  изменить         D / Del  удалить
  S  запустить все видимые                  X  остановить все видимые
  /  или Ctrl+F  поиск (имя, namespace, service, порт, статус); Esc — сбросить
  1 2 3 / Tab    вкладки: Все, Запущенные, Шаблоны
  G              сохранить запущенные сервисы как шаблон
  K              выбор kubeconfig из папки (F2 в списке — сменить папку)
  Q / Ctrl+C     выход (пробросы останавливаются)

ШАБЛОНЫ
  Шаблон — именованный набор сервисов. На вкладке «Шаблоны» Enter или двойной
  клик запускает весь набор, повторное нажатие останавливает его.
  Проще всего: запустите нужные сервисы, нажмите G и назовите шаблон.

ПРО ПРОБРОС
  Упавший проброс (например при рестарте пода) перезапускается сам.
  Если локальный порт занят, сервис покажет ошибку и не запустится.

ФАЙЛЫ
  Установлен в: ${__dirname}
  База данных:  ${DB_FILE}
  Чтобы сбросить всё к стартовому набору, удалите файл базы.`);
  process.exit(0);
}
if (!process.stdin.isTTY) { console.error('Нужен интерактивный терминал'); process.exit(1); }

// bftport --keys: диагностика ввода — показывает сырые байты нажатий и кликов мыши
if (process.argv.includes('--keys')) {
  process.stdout.write('\x1b[?1000h\x1b[?1006h');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  enableConsoleMouse();
  console.log(`terminal: ${process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM || 'не Windows Terminal (conhost/другой)'}`);
  console.log('Кликайте мышью и жмите клавиши. Ничего не появляется при клике — мышь не доходит. Ctrl+C — выход.\r');
  process.stdin.on('data', d => {
    if (d.includes(3)) { process.stdout.write('\x1b[?1000l\x1b[?1006l'); process.exit(0); }
    console.log(JSON.stringify(d.toString()) + '\r');
  });
  return;
}

process.stdout.write('\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1006h');
process.stdin.setRawMode(true);
process.stdin.resume();
enableConsoleMouse();
process.stdin.on('data', onData);
process.stdout.on('resize', draw);
process.on('exit', killAll);
process.on('uncaughtException', e => {
  killAll();
  process.stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l');
  console.error(e);
  process.exit(1);
});
db.services.filter(s => s.autostart).forEach(start);
render();
