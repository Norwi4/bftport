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

// ── язык интерфейса: из настроек, а если не выбран — по языку системы
const i18n = require('./i18n');
let UILANG = db.lang === 'ru' || db.lang === 'en' ? db.lang : (/^ru/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'ru' : 'en');
// Перевод на лету: тексты в коде русские, при English переводятся в момент вывода (поэтому язык меняется без перезапуска).
// Если перевод длиннее/короче исходного, хвост из пробелов подгоняется, чтобы колонки не ехали.
function trKeep(text) {
  const out = i18n.translate(text), pad = i18n.strip(text).length - out.length;
  if (pad === 0 || !/\s$/.test(text)) return out;
  if (pad > 0) return out + ' '.repeat(pad);
  let o = out, extra = -pad;
  while (extra > 0 && / {2}$/.test(o)) { o = o.slice(0, -1); extra--; }
  return o;
}
const D = i18n.D;
const tr = text => (UILANG === 'en' ? i18n.translate(text) : i18n.strip(text));
if (UILANG === 'en') for (const m of ['log', 'error']) { const o = console[m].bind(console); console[m] = (...a) => o(...a.map(x => (typeof x === 'string' ? i18n.translate(x) : x))); }

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
// Вкладка «Кластер» работает только на чтение: приложение вызывает kubectl лишь с этими командами,
// всё остальное (delete, exec, edit, apply, scale…) блокируется здесь, независимо от остального кода.
const READONLY_VERBS = new Set(['get', 'logs', 'port-forward']);
function assertReadOnly(args) {
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '-n' || a === '--namespace') { i++; continue; }
    if (a.startsWith('-')) continue;
    if (!READONLY_VERBS.has(a)) throw new Error('операция запрещена (только просмотр): kubectl ' + a);
    return;
  }
  throw new Error('пустая команда kubectl');
}
function kspawn(args, opts) { assertReadOnly(args); return spawn('kubectl', args, opts); }

// Пробросы к подам из вкладки «Кластер»: живут только в этой сессии и не пишутся в базу.
const eph = new Map();
const allSvcs = () => db.services.concat([...eph.values()]);

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
    `${s.kind === 'pod' ? 'pod' : 'service'}/${s.service}`, `${s.localPort}:${s.remotePort}`];
  const kc = kubeconfigOf(s);
  if (kc) args.push('--kubeconfig=' + kc);
  say(r, '▶ kubectl ' + args.join(' '), true);
  let p;
  try { p = kspawn(args, { windowsHide: true }); }
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
      // под мог быть удалён или пересоздан: бесконечно его догонять нет смысла
      if (s.kind === 'pod' && r.retries > 3) {
        r.want = false; r.status = 'error'; r.info = ('под недоступен (возможно, удалён) · ' + r.info).slice(0, 200);
        say(r, '✖ ' + r.info, true); draw(); return;
      }
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
function killAll() {
  for (const s of allSvcs()) { const r = rt(s); r.want = false; if (r.proc) try { r.proc.kill(); } catch (_) {} }
  if (ui.lv && ui.lv.proc) try { ui.lv.proc.kill(); } catch (_) {}
}

function kubeText(kc, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    try { assertReadOnly(args); } catch (e) { return reject(e); }
    const a = [...args];
    if (kc) a.push('--kubeconfig=' + kc);
    execFile('kubectl', a, { windowsHide: true, maxBuffer: 256 << 20, timeout, encoding: 'utf8' }, (err, out, errOut) => {
      if (err) {
        if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('ответ кластера слишком большой — сузьте выборку (N — namespace)'));
        if (err.killed) return reject(new Error(`kubectl не ответил за ${Math.round(timeout / 1000)} с`));
        return reject(new Error((errOut || err.message).trim().split('\n')[0]));
      }
      resolve(out);
    });
  });
}
const kube = (kc, args) => kubeText(kc, args).then(JSON.parse);

// ───────────────────────── UI-состояние ─────────────────────────
const ui = {
  mode: 'list',        // list | form | picker | confirm
  sel: 0, off: 0,
  form: null, picker: null, confirm: null,
  tab: 'all',          // all | running
  lv: null,            // состояние просмотра логов
  psel: 0, poff: 0, pkey: '', // вкладка «Кластер»: выбранный под
  pods: { list: [], at: 0, err: '', loading: false, ns: '', gen: 0 },
  favSel: { key: '', at: 0, map: new Map(), loading: null }, // selector'ы избранных сервисов: ns/service -> {k: v}
  gsel: 0, goff: 0,    // выбранный шаблон на вкладке «Шаблоны»
  query: '', searching: false,
  lastClick: { id: null, t: 0 },
  flash: '', flashUntil: 0,
};
let W = 80, H = 24, hits = [];

const LAT = { 'й': 'q', 'ф': 'a', 'у': 'e', 'в': 'd', 'ы': 's', 'ч': 'x', 'л': 'k', 'н': 'y', 'т': 'n', 'ш': 'i', 'п': 'g', 'д': 'l', 'щ': 'o', 'ц': 'w', 'к': 'r', 'с': 'c', 'з': 'p', 'а': 'f' };

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

// ───────────────────────── ввод текста: курсор и вставка ─────────────────────────
const isSep = ch => /[\s\\\/.:_-]/.test(ch);
function wordLeft(v, p) { let i = p; while (i > 0 && isSep(v[i - 1])) i--; while (i > 0 && !isSep(v[i - 1])) i--; return i; }
function wordRight(v, p) { let i = p; while (i < v.length && isSep(v[i])) i++; while (i < v.length && !isSep(v[i])) i++; return i; }
// Правит строку o[vk] с курсором o[pk]. Возвращает true, если клавиша обработана как редактирование.
function edit(o, vk, pk, e, digits) {
  let v = String(o[vk]), p = o[pk];
  if (p === undefined || p > v.length) p = v.length;
  if (p < 0) p = 0;
  const ins = t => { if (digits) t = t.replace(/\D/g, ''); v = v.slice(0, p) + t + v.slice(p); p += t.length; };
  switch (e.k) {
    case 'left': p = Math.max(0, p - 1); break;
    case 'right': p = Math.min(v.length, p + 1); break;
    case 'wleft': p = wordLeft(v, p); break;
    case 'wright': p = wordRight(v, p); break;
    case 'home': p = 0; break;
    case 'end': p = v.length; break;
    case 'bs': if (p > 0) { v = v.slice(0, p - 1) + v.slice(p); p--; } break;
    case 'del': v = v.slice(0, p) + v.slice(p + 1); break;
    case 'ctrl-w': { const i = wordLeft(v, p); v = v.slice(0, i) + v.slice(p); p = i; break; }
    case 'ctrl-u': v = ''; p = 0; break;
    case 'space': ins(' '); break;
    case 'char': ins(e.ch); break;
    case 'paste': ins(e.text); break;
    default: return false;
  }
  o[vk] = v; o[pk] = p;
  return true;
}
// Рисует поле шириной width: окно по тексту следует за курсором, курсор — инвертированная клетка.
function addInput(row, o, vk, pk, ok, width, style, active, fn) {
  width = Math.max(2, width);
  const v = String(o[vk]);
  let pos = o[pk];
  if (pos === undefined || pos > v.length) pos = v.length;
  let off = o[ok] || 0;
  if (pos < off) off = pos;
  if (pos > off + width - 1) off = pos - width + 1;
  off = Math.max(0, Math.min(off, Math.max(0, v.length - width + 1)));
  o[ok] = off;
  const view = v.slice(off, off + width), cp = pos - off;
  if (!active) { row.add(view.padEnd(width), style, fn, true); return; }
  const at = view[cp] === undefined ? ' ' : view[cp];
  row.add(view.slice(0, cp), style, fn, true).add(at, style + '\x1b[7m', fn, true).add(view.slice(cp + 1).padEnd(Math.max(0, width - cp - 1)), style, fn, true);
}
const cleanPaste = t => String(t).replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\r\n|\r|\n|\t/g, ' ').replace(/[\x00-\x1f\x7f]/g, '').trim();
// запасной путь для терминалов, которые передают Ctrl+V как символ, а не вставляют сами
function readClipboard(cb) {
  const tries = process.platform === 'win32' ? [['powershell', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw']]]
    : process.platform === 'darwin' ? [['pbpaste', []]]
      : [['wl-paste', ['-n']], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]];
  const next = i => {
    if (i >= tries.length) return cb('');
    execFile(tries[i][0], tries[i][1], { windowsHide: true, timeout: 5000, maxBuffer: 1 << 20, encoding: 'utf8' }, (err, out) => err ? next(i + 1) : cb(out || ''));
  };
  next(0);
}

class Row {
  constructor(y) { this.y = y; this.x = 0; this.out = ''; }
  add(text, style = '', fn, raw = false) {
    text = String(text);
    if (!raw && UILANG === 'en' && (i18n.HAS_CYR.test(text) || text.includes('\u2060'))) text = trKeep(text);
    else text = i18n.strip(text);
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
  else if (ui.mode === 'logs') rows = renderLogs();
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
    const w = b.key.length + tr(b.label).length + 4;
    if (r.x + w > W && r.x > 0) { r = new Row(y + rows.length); rows.push(r); }
    r.add(' ' + b.key + ' ', C.key, b.fn).add(' ' + tr(b.label) + ' ', C.btn, b.fn).add(' ');
  }
  return rows;
}

// полнотекстовый поиск: все слова запроса должны встретиться в метаданных сервиса
function matchKind(s) {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 'meta';
  const r = rt(s);
  const meta = [s.name, s.namespace, s.service, s.localPort, s.remotePort, s.kubeconfig, STATUS[r.status][2], i18n.translate(STATUS[r.status][2]), r.info].join(' ').toLowerCase();
  return terms.every(t => meta.includes(t)) ? 'meta' : null;
}
function visible() {
  // «Избранное» — только сохранённые сервисы; остальные вкладки показывают всё запущенное, включая пробросы к подам
  return (ui.tab === 'all' ? db.services : allSvcs().filter(isActive)).filter(matchKind);
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
  ui.confirm = { msg: `Удалить шаблон «${D(g.name)}»? (сервисы останутся)`, yes: () => { db.groups.splice(db.groups.indexOf(g), 1); saveDb(); closeConfirm(); } };
  draw();
}

function renderGroups(rows) {
  const gs = groupsVisible();
  const nameW = Math.max(12, Math.min(26, Math.floor(W * 0.22)));
  const h = new Row(2);
  h.add(' ', C.head).add('  ' + trunc(tr('ШАБЛОН'), nameW) + ' ', C.head).add(trunc(tr('СТАТУС'), 16) + ' ', C.head).add(tr('СОСТАВ'), C.head).fill(C.head);
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
        if (!db.groups.length) row.add('  Шаблонов нет. ', C.dim).add(' A ', C.key, () => openGroupForm()).add(' создать вручную или ', C.dim).add(' G ', C.key, () => saveRunningAsGroup()).add(' на вкладке «Избранное» — сохранить запущенные', C.dim);
        else row.add('  Ничего не найдено по запросу', C.dim);
      }
      row.fill(); rows.push(row); continue;
    }
    const idx = ui.goff + i, bg = idx === ui.gsel ? C.sel : '', click = () => onGroupClick(idx);
    const st = groupStat(g);
    const [icon, col] = !st.m.length ? ['○', C.gray] : st.err ? ['✖', C.red] : st.run === st.m.length ? ['●', C.green] : st.act ? ['◐', C.yellow] : ['○', C.gray];
    row.add(idx === ui.gsel ? '▌' : ' ', C.yellow + bg, click).add(' ' + icon + ' ', col + bg, click)
      .add(trunc(g.name, nameW) + ' ', C.bold + bg, click, true)
      .add(trunc(`${st.run}/${st.m.length} работает`, 16) + ' ', col + bg, click)
      .add(trunc(st.m.map(s => s.name).join(', '), W - row.x), C.dim + bg, click, true);
    row.fill(bg); rows.push(row);
  }
  const cur = gs[ui.gsel];
  rows.push(new Row(3 + listH).add(' Состав' + (cur ? ': ' + D(cur.name) : '') + ' ', C.head).fill(C.head));
  const ms = cur ? members(cur) : [];
  for (let i = 0; i < logH; i++) {
    const row = new Row(4 + listH + i), s = ms[i];
    if (s) { const st = STATUS[rt(s).status]; row.add(' ' + st[0] + ' ', st[1]).add(trunc(s.name, 28) + ' ', '', undefined, true).add(trunc(`${s.namespace}/${s.service}`, 38) + ' ', C.dim, undefined, true).add(`:${s.localPort}  ${st[2]}`, C.gray); }
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
    { key: 'O', label: 'Настройки', fn: () => openSettings() },
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
    title: g ? `Шаблон: ${D(g.name)}` : 'Новый шаблон', focus: 0, err: '',
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
  const running = allSvcs().filter(s => rt(s).status === 'running').length;
  const activeN = allSvcs().filter(isActive).length;
  const t = new Row(0);
  t.add(` ⇄ Port Forwards v${VERSION} `, C.title).add(` ${db.services.length} сервисов · ${running} работает `, C.title);
  const kc = db.kubeconfig ? '⎈ ' + path.basename(db.kubeconfig) + ' ▾' : 'kubeconfig не выбран (K)';
  const right = ` ${kc} `;
  const fl_ = Date.now() < ui.flashUntil ? tr(' ⚠ ' + ui.flash + ' ') : '';
  if (fl_ && W - t.x > right.length + 4) t.add(fl_.slice(0, W - t.x - right.length - 1), '\x1b[1;93;48;5;25m');
  if (W - t.x > right.length) t.add(' '.repeat(W - t.x - right.length), C.title).add(right, C.title, () => switchKubeconfig());
  t.fill(C.title); rows.push(t);

  const tb = new Row(1);
  const tab = (id, label) => tb.add(` ${tr(label)} `, ui.tab === id ? C.key : C.btn, () => { ui.tab = id; ui.sel = 0; ui.off = 0; ui.gsel = 0; ui.goff = 0; ui.psel = 0; ui.poff = 0; ui.pkey = ''; if (id === 'cluster') refreshPods(); draw(); }).add(' ');
  tb.add(' ');
  tab('all', `1 Избранное (${db.services.length})`); tab('running', `2 Запущенные (${activeN})`); tab('groups', `3 Шаблоны (${db.groups.length})`); tab('cluster', `4 Кластер (${ui.pods.at ? ui.pods.list.length : '…'})`);
  tb.add('  ');
  const goSearch = () => { ui.searching = true; draw(); };
  tb.add(' ⌕ ', ui.searching ? C.inputF : C.input, goSearch);
  const boxW = Math.max(10, Math.min(40, W - tb.x - 12));
  const qs = ui.searching ? C.inputF : (ui.query ? C.input : C.input + C.gray);
  if (ui.query || ui.searching) { tb.add(' ', qs, goSearch); addInput(tb, ui, 'query', 'qpos', 'qoff', boxW - 1, qs, ui.searching, goSearch); tb.add(' ', qs, goSearch); }
  else tb.add(trunc('поиск: / или Ctrl+F', boxW) + ' ', qs, goSearch);
  if (ui.query) tb.add(' ✕ ', C.btn, () => { ui.query = ''; ui.qpos = 0; ui.searching = false; ui.sel = 0; ui.gsel = 0; draw(); });
  if (ui.query) tb.add(` найдено: ${isG ? groupsVisible().length : ui.tab === 'cluster' ? podsVisible().length : svcs.length}`, C.dim);
  tb.fill(); rows.push(tb);
  if (isG) return renderGroups(rows);
  if (ui.tab === 'cluster') return renderCluster(rows);

  const nameW = Math.max(12, Math.min(26, Math.floor(W * 0.22)));
  const targetW = Math.max(16, Math.min(40, Math.floor(W * 0.33)));
  const h = new Row(2);
  h.add(' ', C.head).add('  ' + trunc(tr('СЕРВИС'), nameW) + ' ', C.head).add(trunc('NS / SERVICE', targetW) + ' ', C.head)
    .add(trunc(tr('ПОРТ'), 14) + ' ', C.head).add(tr('СТАТУС'), C.head).fill(C.head);
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
        else row.add(ui.query ? '  Ничего не найдено по запросу' : '  Нет запущенных сервисов — выберите вкладку «Избранное» и нажмите Enter', C.dim);
      }
      row.fill(); rows.push(row); continue;
    }
    const idx = ui.off + i, r = rt(s), st = STATUS[r.status];
    const bg = idx === ui.sel ? C.sel : '';
    const click = () => onRowClick(idx);
    row.add(idx === ui.sel ? '▌' : ' ', C.yellow + bg, click)
      .add(' ' + st[0] + ' ', st[1] + bg, click)
      .add(trunc((s.kind === 'pod' ? '⎈ ' : '') + s.name, nameW) + ' ', C.bold + bg, click, true)
      .add(trunc(`${s.namespace}/${s.kind === 'pod' ? 'pod/' : ''}${s.service}`, targetW) + ' ', C.dim + bg, click, true)
      .add(trunc(`${s.localPort}:${s.remotePort}`, 14) + ' ', bg, click);
    const left = W - row.x;
    const detail = r.status === 'running' || r.status === 'stopped' && !r.info ? st[2] + (s.autostart ? ' · авто' : '') : `${st[2]} · ${r.info}`;
    row.add(trunc(detail, left), (r.status === 'stopped' ? C.gray : st[1]) + bg, click);
    row.fill(bg); rows.push(row);
  }

  const cur = svcs[ui.sel];
  const sep = new Row(3 + listH);
  sep.add(' Логи' + (cur ? ': ' + D(cur.name) : '') + ' ', C.head, () => openLogs()).add(cur ? ' L — открыть на весь экран (логи пода) ' : '', C.head, () => openLogs()).fill(C.head); rows.push(sep);
  const log = cur ? rt(cur).log : [];
  const shown = log.slice(-logH);
  for (let i = 0; i < logH; i++) {
    const row = new Row(4 + listH + i), l = shown[i];
    if (l) row.add(' ' + l.t + ' ', C.gray).add(l.text, l.sys ? C.sys : '', undefined, !l.sys);
    row.fill(); rows.push(row);
  }

  const fy = 4 + listH + logH;
  const btns = [
    { key: 'Enter', label: cur && isActive(cur) ? 'Стоп' : 'Старт', fn: () => toggle() },
    { key: 'A', label: 'Добавить', fn: () => openServiceForm() },
    { key: 'E', label: 'Изменить', fn: () => editService(cur) },
    { key: 'D', label: 'Удалить', fn: () => askDelete() },
    { key: 'S', label: 'Старт все', fn: () => { visible().forEach(start); } },
    { key: 'X', label: 'Стоп все', fn: () => { visible().forEach(stop); draw(); } },
    { key: 'L', label: 'Логи пода', fn: () => openLogs() },
    { key: 'G', label: 'В шаблон', fn: () => saveRunningAsGroup() },
    { key: '/', label: 'Поиск', fn: () => { ui.searching = true; draw(); } },
    { key: 'O', label: 'Настройки', fn: () => openSettings() },
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
function editService(s) {
  if (!s) return;
  if (s.kind === 'pod') return flash('это проброс из вкладки «Кластер»: его можно только остановить (Enter)');
  openServiceForm(s);
}
function askDelete() {
  const s = curSvc(); if (!s) return;
  if (s.kind === 'pod') return flash('это проброс из вкладки «Кластер»: его можно только остановить (Enter)');
  ui.mode = 'confirm';
  ui.confirm = { msg: `Удалить «${D(s.name)}»?`, yes: () => { stop(s); db.services.splice(db.services.indexOf(s), 1); db.groups.forEach(g => { g.services = g.services.filter(id => id !== s.id); }); saveDb(); closeConfirm(); } };
  draw();
}
function askQuit() {
  const n = allSvcs().filter(isActive).length;
  ui.mode = 'confirm';
  ui.confirm = { msg: `Остановить ${n} проброс(ов) и выйти?`, yes: () => exit() };
  draw();
}
function quit() { allSvcs().some(isActive) ? askQuit() : exit(); }
function closeConfirm() { ui.mode = 'list'; ui.confirm = null; draw(); }
function exit() {
  killAll();
  process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l');
  try { process.stdin.setRawMode(false); } catch (_) {}
  process.exit(0);
}

// ───────────────────────── форма ─────────────────────────
function openForm(f) { ui.form = f; ui.mode = 'form'; draw(); }
function closeForm() { ui.form = null; ui.mode = 'list'; draw(); }
const fval = (f, k) => f.fields.find(x => x.key === k).value;
const fset = (f, k, v) => { const fl = f.fields.find(x => x.key === k); fl.value = v; fl.pos = undefined; };

function openServiceForm(s, preset) {
  const src = s || preset; // preset — заготовка для нового сервиса (например, из вкладки «Кластер»)
  const isNew = !s;
  const last = db.services[db.services.length - 1];
  const f = {
    title: s ? `Изменить: ${D(s.name)}` : preset ? 'Добавить в избранное' : 'Новый сервис',
    focus: 0, err: '',
    fields: [
      { key: 'name', label: 'Имя', value: src ? src.name : '' },
      { key: 'namespace', label: 'Namespace', value: src ? src.namespace : (last ? last.namespace : '') },
      { key: 'service', label: 'Service', value: src ? src.service : '' },
      { key: 'localPort', label: 'Локальный порт', value: src ? String(src.localPort) : '', digits: true },
      { key: 'remotePort', label: 'Порт сервиса', value: src ? String(src.remotePort) : 'grpc', hint: 'имя порта (grpc) или номер' },
      { key: 'kubeconfig', label: 'Kubeconfig', value: src ? (src.kubeconfig || '') : '', hint: 'пусто = общий' },
      { key: 'autostart', label: 'Автозапуск', value: src ? !!src.autostart : false, bool: true },
    ],
    buttons: [
      { key: 'Enter', label: 'Сохранить', fn: () => submitService(f, s) },
      { key: 'F2', label: 'Выбрать из кластера', fn: () => discover(f) },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
  };
  if (preset && preset.note) f.info = () => preset.note;
  openForm(f);
}
function submitService(f, s) {
  const v = k => String(fval(f, k)).trim();
  const lp = Number(v('localPort'));
  if (!v('name') || !v('namespace') || !v('service') || !v('remotePort')) return fail(f, 'Заполните имя, namespace, service и порт сервиса');
  if (!(lp >= 1 && lp <= 65535)) return fail(f, 'Локальный порт: число 1–65535');
  const dup = db.services.find(x => x !== s && Number(x.localPort) === lp);
  if (dup) return fail(f, `Порт ${lp} уже занят сервисом «${D(dup.name)}»`);
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
  const apply = () => { db.kubeconfig = file; saveDb(); resetPods(); };
  // пробросы привязаны к кластеру, поэтому при смене конфига останавливаем те, что используют общий
  const act = allSvcs().filter(s => isActive(s) && !s.kubeconfig);
  if (!act.length) { apply(); return draw(); }
  ui.mode = 'confirm';
  ui.confirm = { msg: `Переключить на «${D(path.basename(file))}»? Будет остановлено пробросов: ${act.length}`, yes: () => { act.forEach(stop); for (const [k, v] of eph) if (act.includes(v)) eph.delete(k); apply(); closeConfirm(); } };
  draw();
}
// Настройки: папка с kubeconfig, язык интерфейса, сведения о приложении
function openSettings() {
  const f = {
    title: 'Настройки', focus: 0, err: '',
    fields: [
      { key: 'dir', label: 'Папка с kubeconfig', value: db.kubeconfigDir || '', hint: 'например C:\\Users\\me\\kube' },
      { key: 'lang', label: 'Язык / Language', value: UILANG, choice: [{ v: 'ru', label: 'Русский' }, { v: 'en', label: 'English' }] },
    ],
    buttons: [
      { key: 'Enter', label: 'Сохранить', fn: () => submitSettings(f) },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
    submit: () => submitSettings(f),
  };
  f.info = () => ['', 'О приложении', `  Версия: ${VERSION}`];
  openForm(f);
}
function submitSettings(f) {
  const raw = String(fval(f, 'dir')).trim().replace(/^"|"$/g, '');
  let dir = '';
  if (raw) {
    dir = path.resolve(expandHome(raw));
    let ok = false;
    try { ok = fs.statSync(dir).isDirectory(); } catch (_) {}
    if (!ok) return fail(f, 'Такой папки нет: ' + dir);
  }
  db.kubeconfigDir = dir;
  const lang = fval(f, 'lang');
  if (lang === 'ru' || lang === 'en') { db.lang = lang; UILANG = lang; }
  saveDb(); closeForm();
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
    r.add('  ').add(trunc(tr(fl.label), labelW), focus ? C.yellow : C.dim, focusFn);
    if (fl.bool) {
      r.add(fl.value ? ' [x] ' : ' [ ] ', focus ? C.inputF : C.input, focusFn);
    } else if (fl.choice) {
      for (const o of fl.choice) {
        const on = o.v === fl.value;
        r.add(` ${on ? '●' : '○'} ${o.label} `, on ? (focus ? C.inputF : C.input + C.bold) : C.input + C.gray, () => { f.focus = i; fl.value = o.v; draw(); }, true).add(' ');
      }
    } else {
      const txt = String(fl.value), st = focus ? C.inputF : C.input;
      r.add(' ', st, focusFn);
      if (!txt && !focus && fl.hint) r.add(fl.hint.padEnd(boxW - 2).slice(0, boxW - 2), C.input + C.gray, focusFn);
      else addInput(r, fl, 'value', 'pos', 'vs', boxW - 2, st, focus, focusFn);
      r.add(' ', st, focusFn);
      if (focus && !txt && fl.hint) r.add(' ' + fl.hint, C.gray);
    }
    r.fill(); rows.push(r);
  });
  const y0 = 2 + f.fields.length;
  const infoLines = [].concat(f.info ? f.info() : '');
  infoLines.forEach((t, k) => rows.push(new Row(y0 + k).add('  ' + t, C.sys).fill()));
  const yb = y0 + infoLines.length;
  rows.push(new Row(yb).add('  ' + f.err, C.red).fill());
  for (const r of buttonRows(yb + 1, f.buttons)) { r.fill(); rows.push(r); }
  rows.push(new Row(yb + 3).add('  Tab/↑↓ — поля · ←→ Home End — курсор · Ctrl+V — вставить · Ctrl+U — очистить · Пробел — галочка/выбор', C.gray).fill());
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
    case 'ctrl-c': return quit();
    default:
      if (fl.bool) { if (e.k === 'space') fl.value = !fl.value; }
      else if (fl.choice) {
        if (e.k === 'left' || e.k === 'right' || e.k === 'space') {
          const i = fl.choice.findIndex(o => o.v === fl.value), d = e.k === 'left' ? -1 : 1;
          fl.value = fl.choice[(i + d + fl.choice.length) % fl.choice.length].v;
        }
      } else edit(fl, 'value', 'pos', e, fl.digits);
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
    Promise.resolve(loader).then(items => { p.items = items; if (opts.current !== undefined) { const i = items.findIndex(x => x.value === opts.current || (typeof x.value === 'string' && typeof opts.current === 'string' && sameFile(x.value, opts.current))); if (i >= 0) p.sel = i; } draw(); }, err => { p.err = err.message; draw(); });
  });
}
function filtered(p) {
  const q = p.filter.toLowerCase();
  return (p.items || []).filter(i => i.label.toLowerCase().includes(q));
}
function renderPicker() {
  const p = ui.picker, rows = [];
  rows.push(new Row(0).add(' ' + p.title + ' ', C.title).fill(C.title));
  const fr = new Row(1).add('  Фильтр: ', C.dim);
  addInput(fr, p, 'filter', 'fpos', 'foff', Math.max(10, Math.min(60, W - 16)), C.input, true);
  rows.push(fr.fill());
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
    case 'ctrl-c': return p.done(null);
    case 'space': if (p.multi) { if (items[p.sel]) toggleChecked(p, items[p.sel]); return; } // иначе — пробел в фильтре
    // fallthrough
    default: { const was = p.filter; if (edit(p, 'filter', 'fpos', e) && p.filter !== was) p.sel = 0; }
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

// ───────────────────────── формат логов по шаблону logback ─────────────────────────
// Сервисы в кластере пишут логи в JSON. Чтобы их было удобно читать, строки приводятся к шаблону logback:
// берём <pattern> из ~/.m2/logback-local.xml, а если файла нет — встроенный (такой же, как в нём).
const DEFAULT_LOG_PATTERN = '%d{yyyy-MM-dd HH:mm:ss.SSS} %-5level [%thread] [traceId = %X{traceId}] [spanId = %X{spanId}] %logger{36} - %message%n%rEx';
function loadLogPattern() {
  try {
    const xml = fs.readFileSync(path.join(require('os').homedir(), '.m2', 'logback-local.xml'), 'utf8');
    const m = /<pattern>([\s\S]*?)<\/pattern>/.exec(xml);
    if (m && m[1].trim()) return m[1].trim().replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  } catch (_) {}
  return DEFAULT_LOG_PATTERN;
}
function compileLogPattern(pat) {
  const toks = [], re = /%(-?)(\d*)(?:\.(\d+))?([a-zA-Z]+)(?:\{([^}]*)\})?|%%|[^%]+|%/g;
  let m;
  while ((m = re.exec(pat))) {
    if (m[4]) toks.push({ left: m[1] === '-', min: m[2] ? +m[2] : 0, max: m[3] ? +m[3] : 0, word: m[4], opt: m[5] });
    else toks.push({ lit: m[0] === '%%' ? '%' : m[0] });
  }
  return toks;
}
const LOG_TOKENS = compileLogPattern(loadLogPattern());

const pick1 = (o, keys) => { for (const k of keys) { const v = k.includes('.') && !(k in o) ? k.split('.').reduce((a, x) => (a == null ? a : a[x]), o) : o[k]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
function fmtDate(v, f) {
  if (v === undefined) return '';
  let d = typeof v === 'number' ? new Date(v < 1e11 ? v * 1000 : v) : new Date(v);
  if (isNaN(d)) return String(v);
  const map = { yyyy: d.getFullYear(), MM: pad2(d.getMonth() + 1), dd: pad2(d.getDate()), HH: pad2(d.getHours()), mm: pad2(d.getMinutes()), ss: pad2(d.getSeconds()), SSS: String(d.getMilliseconds()).padStart(3, '0') };
  return f.replace(/yyyy|MM|dd|HH|mm|ss|SSS/g, t => map[t]);
}
// logback сокращает пакеты до одной буквы слева направо, пока имя не уложится в заданную длину
function abbrevLogger(name, n) {
  if (!n || name.length <= n) return name;
  const parts = name.split('.');
  for (let i = 0; i < parts.length - 1 && parts.join('.').length > n; i++) parts[i] = parts[i][0];
  return parts.join('.');
}
function parseLogJson(text) {
  const m = /^(\[pod\/[^\]]*\]\s)?(\{[\s\S]*\})\s*$/.exec(text);
  if (!m) return null;
  let o;
  try { o = JSON.parse(m[2]); } catch (_) { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const message = pick1(o, ['message', 'msg', '@m', 'log', 'event']);
  const level = pick1(o, ['level', 'log.level', 'severity', 'levelName', '@l', 'lvl']);
  if (message === undefined && level === undefined) return null; // не похоже на запись лога
  const mdc = (o.mdc && typeof o.mdc === 'object') ? o.mdc : (o.MDC && typeof o.MDC === 'object') ? o.MDC : {};
  const trace = pick1(o, ['traceId', 'trace_id', 'trace.id', 'X-B3-TraceId', 'x-b3-traceid']) ?? pick1(mdc, ['traceId', 'trace_id', 'X-B3-TraceId']);
  const span = pick1(o, ['spanId', 'span_id', 'span.id', 'X-B3-SpanId', 'x-b3-spanid']) ?? pick1(mdc, ['spanId', 'span_id', 'X-B3-SpanId']);
  const stack = pick1(o, ['stack_trace', 'stackTrace', 'exception', 'throwable', 'error.stack_trace', 'exc_info']);
  return {
    prefix: m[1] || '', time: pick1(o, ['@timestamp', 'timestamp', 'time', 'ts', '@t', 'date']),
    level: level === undefined ? '' : String(level).toUpperCase(),
    thread: pick1(o, ['thread_name', 'thread', 'process.thread.name', 'threadName']),
    logger: pick1(o, ['logger_name', 'logger', 'log.logger', 'loggerName', 'class']),
    message: message === undefined ? '' : (typeof message === 'string' ? message : JSON.stringify(message)),
    mdc: { ...mdc, ...o, ...(trace !== undefined ? { traceId: trace } : {}), ...(span !== undefined ? { spanId: span } : {}) },
    stack: stack === undefined ? '' : (typeof stack === 'string' ? stack : JSON.stringify(stack)),
  };
}
function formatLog(text) {
  const f = parseLogJson(text);
  if (!f) return null;
  let line = '';
  for (const t of LOG_TOKENS) {
    if (t.lit !== undefined) { line += t.lit; continue; }
    let v = '';
    switch (t.word) {
      case 'd': case 'date': v = fmtDate(f.time, t.opt || 'yyyy-MM-dd HH:mm:ss.SSS'); break;
      case 'level': case 'p': v = f.level; break;
      case 'thread': case 't': v = f.thread ?? ''; break;
      case 'logger': case 'c': case 'lo': v = abbrevLogger(String(f.logger ?? ''), t.opt ? +t.opt : 0); break;
      case 'message': case 'msg': case 'm': v = f.message; break;
      case 'X': case 'mdc': { const x = f.mdc[t.opt]; v = x === undefined || x === null ? '' : (typeof x === 'object' ? JSON.stringify(x) : String(x)); break; }
      default: v = ''; // %n, %rEx/%ex и неизвестные слова выводятся отдельно или пропускаются
    }
    v = String(v);
    if (t.max && v.length > t.max) v = v.slice(0, t.max);
    if (t.min && v.length < t.min) v = t.left ? v.padEnd(t.min) : v.padStart(t.min);
    line += v;
  }
  const out = [], lvl = f.level;
  // многострочное сообщение: продолжение показываем отдельными строками того же уровня
  const msgLines = (f.prefix + line).split(/\r?\n/);
  msgLines.forEach(l => out.push({ text: cleanLine(l), lvl }));
  if (f.stack) f.stack.split(/\r?\n/).forEach(l => { if (l.trim()) out.push({ text: cleanLine(l), lvl, dim: !/^\s*(Caused by|Exception|[\w.$]+(Exception|Error))/.test(l) }); });
  return out;
}

// ───────────────────────── вкладка «Кластер»: все поды, только просмотр ─────────────────────────
const podKey = p => p.ns + '/' + p.name;
function podSvc(p) {
  return eph.get(podKey(p)) || { id: 'pod:' + podKey(p), name: p.name, namespace: p.ns, service: p.name, kind: 'pod', kubeconfig: '', localPort: 0, remotePort: 0 };
}
function flash(msg) {
  ui.flash = msg; ui.flashUntil = Date.now() + 7000;
  draw(); setTimeout(draw, 7100);
}
// Под эфемерен, а в избранное попадают сервисы: находим Service, который выбирает этот под (selector ⊆ labels пода),
// и заполняем форму его настройками — имя, namespace, порт сервиса и свободный локальный порт.
async function podToFavorite(p) {
  if (!db.kubeconfig) return switchKubeconfig();
  const d = await getDetail(p);
  if (!d) { const e = podDet.get(podKey(p)); return flash('не удалось получить данные пода: ' + ((e && e.err) || 'нет ответа')); }
  let items;
  try { items = (await kube(db.kubeconfig, ['-n', p.ns, 'get', 'svc', '-o', 'json'])).items; }
  catch (e) { return flash('не удалось получить сервисы: ' + e.message); }
  const labels = d.labels || {};
  const match = items.filter(i => {
    const sel = (i.spec && i.spec.selector) || {}, keys = Object.keys(sel);
    return keys.length && keys.every(k => labels[k] === sel[k]) && (i.spec.ports || []).length;
  });
  if (!match.length) return flash(`у пода нет Service в namespace ${p.ns} — в избранное добавляются сервисы`);
  let svc = match[0];
  if (match.length > 1) {
    svc = await pick(`Service пода ${p.name}`, match.map(i => ({ label: `${db.services.some(x => x.namespace === p.ns && x.service === i.metadata.name) ? '★ ' : '  '}${i.metadata.name.padEnd(36)} ${(i.spec.ports || []).map(x => (x.name ? x.name + ':' : '') + x.port).join('  ')}${db.services.some(x => x.namespace === p.ns && x.service === i.metadata.name) ? '   (уже в избранном)' : ''}`, value: i })));
    if (!svc) return;
  }
  const have = db.services.find(x => x.namespace === p.ns && x.service === svc.metadata.name);
  if (have) {
    ui.tab = 'all'; ui.query = ''; ui.sel = Math.max(0, db.services.indexOf(have)); ui.off = 0;
    flash(`«${D(have.name)}» уже в избранном`); return draw();
  }
  let port = svc.spec.ports[0];
  if (svc.spec.ports.length > 1) {
    port = await pick(`Порт сервиса ${svc.metadata.name}`, svc.spec.ports.map(x => ({ label: `${x.name || '(без имени)'}  ${x.port}/${x.protocol || 'TCP'} → ${x.targetPort}`, value: x })));
    if (!port) return;
  }
  const used = new Set(allSvcs().filter(x => x.localPort).map(x => Number(x.localPort)));
  let local = port.port;
  while (used.has(local) && local < 65535) local++;
  const taken = db.services.some(x => x.name === svc.metadata.name);
  openServiceForm(null, {
    name: taken ? `${svc.metadata.name}-${p.ns}` : svc.metadata.name, namespace: p.ns, service: svc.metadata.name,
    localPort: local, remotePort: port.name || String(port.port), kubeconfig: '', autostart: false,
    note: `Заполнено по поду ${p.name} (service ${svc.metadata.name}). Проверьте и нажмите Enter.`,
  });
}
function podRecord(i) {
  const st = i.status || {}, spec = i.spec || {}, md = i.metadata || {};
  const cs = st.containerStatuses || [], ics = st.initContainerStatuses || [];
  let status = st.phase || 'Unknown';
  if (md.deletionTimestamp) status = 'Terminating';
  else {
    const iw = ics.find(c => c.state && c.state.waiting && c.state.waiting.reason);
    const w = cs.find(c => c.state && c.state.waiting && c.state.waiting.reason);
    const t = cs.find(c => c.state && c.state.terminated && c.state.terminated.reason && !c.ready);
    if (iw) status = 'Init:' + iw.state.waiting.reason;
    else if (w) status = w.state.waiting.reason;
    else if (t && st.phase !== 'Succeeded') status = t.state.terminated.reason;
    else if (st.reason) status = st.reason;
    else if (st.phase === 'Succeeded') status = 'Completed';
  }
  const containers = spec.containers || [];
  const ports = [];
  for (const c of containers) for (const pt of c.ports || []) ports.push({ container: c.name, name: pt.name || '', port: pt.containerPort, protocol: pt.protocol || 'TCP' });
  return {
    ns: md.namespace || '', name: md.name || '', status, phase: st.phase || '',
    ready: cs.filter(c => c.ready).length, total: containers.length,
    restarts: cs.reduce((a, c) => a + (c.restartCount || 0), 0),
    created: md.creationTimestamp || '', start: st.startTime || '', node: spec.nodeName || '', ip: st.podIP || '',
    containers: containers.map(c => c.name), ports, labels: md.labels || {},
  };
}
function podColor(p) {
  if (/^(Completed|Succeeded)$/.test(p.status)) return C.gray;
  if (/Error|CrashLoop|BackOff|Failed|Evicted|OOM|Unknown|ErrImage|Invalid|CreateContainer/i.test(p.status)) return C.red;
  if (/Pending|ContainerCreating|PodInitializing|Terminating|Init|Waiting/i.test(p.status)) return C.yellow;
  if (p.status === 'Running') return p.ready === p.total ? C.green : C.yellow;
  return '';
}
function podsVisible() {
  const terms = ui.query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return ui.pods.list;
  return ui.pods.list.filter(p => { const h = (p.ns + ' ' + p.name + ' ' + p.status).toLowerCase(); return terms.every(t => h.includes(t)); });
}
function parseLabels(v) {
  const o = {};
  if (!v || v === '<none>') return o;
  for (const kv of v.split(',')) { const j = kv.indexOf('='); if (j > 0) o[kv.slice(0, j)] = kv.slice(j + 1); }
  return o;
}
const noneToEmpty = v => (!v || v === '<none>') ? '' : v;
// Колонки kubectl разделены минимум тремя пробелами, а внутри значений (например «3 (2h ago)») пробел одиночный.
function parsePodTable(txt, withNs, ns) {
  const out = [];
  for (const line of txt.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.trim().split(/\s{2,}/), i = withNs ? 1 : 0;
    const m = /^(\d+)\/(\d+)$/.exec(c[i + 1] || '');
    if (!m) continue; // служебные строки вроде «No resources found»
    out.push({
      ns: withNs ? c[0] : ns, name: c[i], ready: +m[1], total: +m[2], status: c[i + 2] || '',
      restartsText: c[i + 3] || '0', restarts: parseInt(c[i + 3], 10) || 0, age: c[i + 4] || '',
      ip: noneToEmpty(c[i + 5]), node: noneToEmpty(c[i + 6]), labels: parseLabels(c[i + 9]),
    });
  }
  return out;
}
// Подробности выбранного пода (контейнеры, порты, время создания) — одним небольшим запросом и с кэшем.
const podDet = new Map(); // ns/name -> { at, d, err, loading }
let detTimer = null;
const detailOf = p => { const e = podDet.get(podKey(p)); return e && e.d; };
function wantDetail(p) {
  if (!p) return;
  const e = podDet.get(podKey(p));
  if (e && (e.loading || Date.now() - e.at < 30000)) return;
  clearTimeout(detTimer);
  detTimer = setTimeout(() => loadDetail(p), 200);
}
async function loadDetail(p) {
  const e = { at: Date.now(), d: null, err: '', loading: true };
  podDet.set(podKey(p), e);
  try { e.d = podRecord(await kube(db.kubeconfig, ['-n', p.ns, 'get', 'pod', p.name, '-o', 'json'])); }
  catch (er) { e.err = er.message; }
  finally { e.loading = false; e.at = Date.now(); draw(); }
}
async function getDetail(p) {
  let e = podDet.get(podKey(p));
  if (e && e.loading) { while (e.loading) await new Promise(r => setTimeout(r, 40)); return e.d; }
  if (!e || !e.d || Date.now() - e.at > 30000) { await loadDetail(p); e = podDet.get(podKey(p)); }
  return e.d;
}

// Какие избранные сервисы относятся к поду: selector сервиса целиком входит в метки пода.
async function ensureFavSel(force) {
  const F = ui.favSel, kc = db.kubeconfig;
  const wanted = [...new Set(db.services.map(x => x.namespace))].sort();
  const key = kc + '|' + wanted.join(',');
  if (!force && F.key === key && Date.now() - F.at < 60000) return;
  if (F.loading) return F.loading;
  F.loading = (async () => {
    const map = new Map();
    if (kc) await Promise.all(wanted.map(async ns => {
      try {
        const d = await kube(kc, ['-n', ns, 'get', 'svc', '-o', 'json']);
        for (const i of d.items) { const sel = i.spec && i.spec.selector; if (sel && Object.keys(sel).length) map.set(ns + '/' + i.metadata.name, sel); }
      } catch (_) { /* нет прав на этот namespace — просто не сопоставляем */ }
    }));
    F.map = map; F.key = key; F.at = Date.now();
  })().finally(() => { F.loading = null; draw(); });
  return F.loading;
}
function favsFor(p) {
  return db.services.filter(f => {
    if (f.namespace !== p.ns) return false;
    const sel = ui.favSel.map.get(f.namespace + '/' + f.service);
    return sel && Object.keys(sel).every(k => (p.labels || {})[k] === sel[k]);
  });
}
// Что показывать в колонке «ПРОБРОС»: прямой проброс к поду или состояние избранного сервиса, к которому под относится.
function podFwd(p) {
  const e = eph.get(podKey(p));
  if (e && (isActive(e) || rt(e).status === 'error')) { const r = rt(e); return { text: `⇄ :${e.localPort}${r.status === 'running' ? '' : ' ' + STATUS[r.status][2]}`, status: r.status }; }
  const favs = favsFor(p);
  const f = favs.find(isActive) || favs.find(x => rt(x).status === 'error');
  if (f) { const r = rt(f); return { text: `★ ${f.name} :${f.localPort}${r.status === 'running' ? '' : ' ' + STATUS[r.status][2]}`, status: r.status }; }
  if (favs.length) return { text: '★ ' + favs.map(x => x.name).join(', '), status: 'stopped' };
  return null;
}

function resetPods(keepNs) {
  const P = ui.pods;
  ui.pods = { list: [], at: 0, err: '', loading: false, ns: keepNs ? P.ns : '', gen: P.gen + 1, dur: 0 };
  podDet.clear(); ui.favSel.at = 0;
  ui.psel = 0; ui.poff = 0; ui.pkey = '';
  if (ui.tab === 'cluster') refreshPods();
}
async function refreshPods() {
  const P = ui.pods;
  if (P.loading) return;
  const kc = db.kubeconfig;
  if (!kc) { P.err = 'kubeconfig не выбран — нажмите K'; P.list = []; return draw(); }
  P.loading = true; const gen = P.gen; draw();
  try {
    // Таблица считается на стороне API-сервера (как в обычном «kubectl get pods»): в десятки раз меньше данных, чем JSON.
    // Контейнеры и порты выбранного пода подгружаются отдельно (loadDetail).
    const t0 = Date.now();
    const txt = await kubeText(kc, ['get', 'pods', ...(P.ns ? ['-n', P.ns] : ['-A']), '-o', 'wide', '--show-labels', '--no-headers'], 90000);
    if (gen !== P.gen) return;
    P.list = parsePodTable(txt, !P.ns, P.ns).sort((a, b) => a.ns.localeCompare(b.ns) || a.name.localeCompare(b.name));
    P.err = ''; P.at = Date.now(); P.dur = P.at - t0;
    ensureFavSel(); // не ждём: связь «под ↔ избранный сервис» подтянется следом
    const i = podsVisible().findIndex(x => podKey(x) === ui.pkey); // выбор «прилипает» к поду, а не к номеру строки
    if (i >= 0) ui.psel = i;
  } catch (e) { if (gen === P.gen) P.err = e.message; }
  finally { if (gen === P.gen) { P.loading = false; draw(); } }
}
// на большом кластере не дёргаем API-сервер часто: пауза между обновлениями растёт вместе со временем загрузки
setInterval(() => { if (ui.tab === 'cluster' && ui.mode === 'list' && !ui.searching && Date.now() - ui.pods.at > Math.max(8000, (ui.pods.dur || 0) * 8)) refreshPods(); }, 4000);

function renderCluster(rows) {
  const P = ui.pods, ps = podsVisible();
  const nsW = Math.max(10, Math.min(24, Math.floor(W * 0.16)));
  const nameW = Math.max(12, W - (1 + 3 + nsW + 1) - 7 - 17 - 5 - 7 - 10);
  const h = new Row(2);
  h.add('    ', C.head).add(trunc('NAMESPACE', nsW) + ' ', C.head).add(trunc(tr('ИМЯ'), nameW) + ' ', C.head).add(trunc('READY', 6) + ' ', C.head)
    .add(trunc(tr('СТАТУС'), 16) + ' ', C.head).add(trunc(tr('РЕСТ'), 4) + ' ', C.head).add(trunc(tr('ВОЗРАСТ'), 6) + ' ', C.head).add(tr('ПРОБРОС'), C.head).fill(C.head);
  rows.push(h);
  const logH = Math.max(3, Math.min(10, Math.floor(H * 0.3)));
  const listH = Math.max(3, H - 6 - logH);
  if (ui.psel >= ps.length) ui.psel = Math.max(0, ps.length - 1);
  if (ui.psel < ui.poff) ui.poff = ui.psel;
  if (ui.psel >= ui.poff + listH) ui.poff = ui.psel - listH + 1;
  const cur = ps[ui.psel];
  ui.pkey = cur ? podKey(cur) : '';
  wantDetail(cur);
  for (let i = 0; i < listH; i++) {
    const row = new Row(3 + i), p = ps[ui.poff + i];
    if (!p) {
      if (i === 1 && !ps.length) {
        if (P.err) row.add('  ' + P.err, C.red);
        else if (!P.at) row.add(P.loading ? '  Загрузка подов из кластера…' : '  Нет данных', C.yellow);
        else row.add(ui.query ? '  Ничего не найдено по запросу' : '  В выбранном namespace нет подов', C.dim);
      } else if (i === 2 && !ps.length && P.err) row.add('  N — выбрать namespace (если нет прав на весь кластер) · R — повторить · K — другой конфиг', C.gray);
      row.fill(); rows.push(row); continue;
    }
    const idx = ui.poff + i, bg = idx === ui.psel ? C.sel : '', click = () => onPodClick(idx), col = podColor(p);
    const fw = podFwd(p);
    row.add(idx === ui.psel ? '▌' : ' ', C.yellow + bg, click).add(' ● ', col + bg, click)
      .add(trunc(p.ns, nsW) + ' ', C.dim + bg, click, true).add(trunc(p.name, nameW) + ' ', C.bold + bg, click, true)
      .add(trunc(`${p.ready}/${p.total}`, 6) + ' ', (p.ready === p.total ? '' : C.yellow) + bg, click)
      .add(trunc(p.status, 16) + ' ', col + bg, click).add(trunc(String(p.restarts), 4) + ' ', (p.restarts ? C.yellow : C.gray) + bg, click)
      .add(trunc(p.age, 6) + ' ', C.gray + bg, click)
      .add(trunc(fw ? fw.text : '', Math.max(0, W - row.x)), (!fw || fw.status === 'stopped' ? C.gray : fw.status === 'error' ? C.red : fw.status === 'running' ? C.green : C.yellow) + bg, click);
    row.fill(bg); rows.push(row);
  }
  const nsLabel = P.ns ? 'namespace: ' + P.ns : 'все namespace';
  const upd = P.at ? new Date(P.at).toTimeString().slice(0, 8) : '—';
  rows.push(new Row(3 + listH).add(` Детали${cur ? ': ' + podKey(cur) : ''} `, C.head)
    .add(` ${ps.length}/${P.list.length} подов · ${nsLabel} · обновлено ${upd}${P.loading ? ' · обновление…' : ''} · только просмотр `, C.head).fill(C.head));
  const det = [];
  if (cur) {
    const e = podDet.get(podKey(cur)), d = e && e.d;
    det.push(`узел: ${cur.node || '—'}   IP: ${cur.ip || '—'}   возраст: ${cur.age}   перезапусков: ${cur.restartsText}${d && d.created ? '   создан: ' + fmtStart(d.created) : ''}`);
    for (const f of favsFor(cur)) det.push(`★ избранное: ${D(f.name)} (${f.namespace}/${f.service})  :${f.localPort} → ${f.remotePort}  · ${STATUS[rt(f).status][2]}`);
    if (d) {
      for (const c of d.containers) {
        const ports = d.ports.filter(x => x.container === c).map(x => `${x.port}/${x.protocol}${x.name ? ' (' + x.name + ')' : ''}`);
        det.push(`• ${c}   ${ports.length ? 'порты: ' + ports.join(', ') : 'порты не объявлены'}`);
      }
    } else det.push(e && e.err ? 'не удалось получить подробности: ' + e.err : 'загрузка подробностей…');
  }
  for (let i = 0; i < logH; i++) rows.push(new Row(4 + listH + i).add(det[i] ? ' ' + det[i] : '', i === 0 ? '' : C.dim).fill());
  const fs2 = cur && eph.get(podKey(cur)), favs2 = cur ? favsFor(cur) : [];
  const anyOn = (fs2 && isActive(fs2)) || favs2.some(isActive);
  const btns = [
    { key: 'Enter', label: anyOn ? 'Стоп проброса' : favs2.length ? 'Проброс (избранное)' : 'Проброс порта', fn: () => podAction() },
    ...(favs2.length || anyOn ? [{ key: 'P', label: 'Напрямую к поду', fn: () => cur && directForward(cur) }] : []),
    { key: 'L', label: 'Логи', fn: () => cur && openPodLogs(cur) },
    { key: 'F', label: 'В избранное', fn: () => cur && podToFavorite(cur) },
    { key: 'N', label: 'Namespace', fn: () => chooseNamespace() },
    { key: 'R', label: 'Обновить', fn: () => refreshPods() },
    { key: '/', label: 'Поиск', fn: () => { ui.searching = true; draw(); } },
    { key: 'O', label: 'Настройки', fn: () => openSettings() },
    { key: 'K', label: 'Конфиг', fn: () => switchKubeconfig() },
    { key: 'Q', label: 'Выход', fn: () => quit() },
  ];
  for (const r of buttonRows(4 + listH + logH, btns)) { r.fill(); rows.push(r); }
  return rows;
}
function onPodClick(idx) {
  const p = podsVisible()[idx], now = Date.now();
  if (ui.lastClick.id === podKey(p) && now - ui.lastClick.t < 450) { ui.psel = idx; ui.lastClick = { id: null, t: 0 }; podAction(); }
  else { ui.psel = idx; ui.lastClick = { id: podKey(p), t: now }; draw(); }
}
async function chooseNamespace() {
  const kc = db.kubeconfig;
  if (!kc) return switchKubeconfig();
  const res = await pick('Namespace', kube(kc, ['get', 'ns', '-o', 'json']).then(d => [{ label: 'Все namespace', value: '' }, ...d.items.map(i => i.metadata.name).sort().map(n => ({ label: n, value: n }))]), { f2: 'Ввести вручную', current: ui.pods.ns });
  if (res === PICK_FOLDER) return openNsForm();
  if (res === null) return;
  ui.pods.ns = res; resetPods(true);
}
function openNsForm() {
  const f = {
    title: 'Namespace', focus: 0, err: '', fields: [{ key: 'ns', label: 'Namespace', value: ui.pods.ns, hint: 'пусто = все namespace' }],
    buttons: [
      { key: 'Enter', label: 'Показать', fn: () => { ui.pods.ns = String(fval(f, 'ns')).trim(); closeForm(); resetPods(true); } },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
    submit: () => f.buttons[0].fn(),
  };
  openForm(f);
}
const DIRECT = { direct: true };
// Enter: если под относится к сервису из избранного — управляем этим сервисом (его порт, его состояние, он же виден в «Запущенных»);
// иначе пробрасываем порт пода напрямую.
async function podAction() {
  const p = podsVisible()[ui.psel]; if (!p) return;
  const e = eph.get(podKey(p));
  if (e && isActive(e)) { stop(e); return draw(); }
  await ensureFavSel();
  const favs = favsFor(p), act = favs.filter(isActive);
  if (act.length) { act.forEach(stop); return draw(); }
  if (favs.length === 1) { start(favs[0]); return draw(); }
  if (favs.length > 1) {
    const items = [...favs.map(f => ({ label: `★ ${f.name.padEnd(28)} ${f.namespace}/${f.service}  :${f.localPort} → ${f.remotePort}`, value: f })), { label: 'Напрямую к поду (выбрать порт)', value: DIRECT }];
    const c = await pick(`Через какой сервис пробросить (${p.name})`, items);
    if (!c) return;
    if (c === DIRECT) return openPodForward(p);
    start(c); return draw();
  }
  openPodForward(p);
}
function directForward(p) {
  const e = eph.get(podKey(p));
  if (e && isActive(e)) { stop(e); return draw(); }
  openPodForward(p);
}
async function openPodForward(p) {
  const d = await getDetail(p), ports = d ? d.ports : [];
  const used = new Set(allSvcs().filter(x => x.localPort && isActive(x)).map(x => Number(x.localPort)));
  const remote = ports.length ? ports[0].port : '';
  let local = remote || '';
  while (local && used.has(Number(local)) && local < 65535) local++;
  const f = {
    title: `Проброс порта пода ${p.name}`, focus: 0, err: '',
    fields: [
      { key: 'lport', label: 'Локальный порт', value: String(local), digits: true },
      { key: 'rport', label: 'Порт пода', value: String(remote), digits: true, hint: 'номер порта контейнера' },
    ],
    buttons: [
      { key: 'Enter', label: 'Пробросить', fn: () => submitPodForward(f, p) },
      { key: 'F2', label: 'Выбрать порт пода', fn: () => choosePodPort(f, p, ports) },
      { key: 'Esc', label: 'Отмена', fn: closeForm },
    ],
    submit: () => submitPodForward(f, p),
  };
  f.info = () => ports.length ? 'Порты пода: ' + ports.map(x => `${x.port}${x.name ? '(' + x.name + ')' : ''}/${x.protocol}`).join(', ') : 'У пода порты не объявлены — укажите порт вручную';
  openForm(f);
}
async function choosePodPort(f, p, ports) {
  if (!ports.length) { f.err = 'У пода нет объявленных портов'; return draw(); }
  const items = ports.map(x => ({ label: `${x.port}/${x.protocol}  ${x.name || ''}  (контейнер ${x.container})`, value: x.port }));
  const v = await pick(`Порт пода ${p.name}`, items);
  if (v) { fset(f, 'rport', String(v)); if (!String(fval(f, 'lport')).trim()) fset(f, 'lport', String(v)); }
  draw();
}
function submitPodForward(f, p) {
  const lp = Number(String(fval(f, 'lport')).trim()), rp = Number(String(fval(f, 'rport')).trim());
  if (!(lp >= 1 && lp <= 65535)) return fail(f, 'Локальный порт: число 1–65535');
  if (!(rp >= 1 && rp <= 65535)) return fail(f, 'Порт пода: число 1–65535');
  const s = podSvc(p);
  const dup = allSvcs().find(x => x !== s && Number(x.localPort) === lp && isActive(x));
  if (dup) return fail(f, `Порт ${lp} уже занят сервисом «${D(dup.name)}»`);
  s.localPort = lp; s.remotePort = rp;
  eph.set(podKey(p), s);
  closeForm(); start(s);
}
// Логи пода: тот же просмотр, что и для сервиса, но без выбора пода — выбран конкретный
function openPodLogs(p) {
  const s = podSvc(p), d = detailOf(p);
  ui.lv = { svc: s, src: 'pod', pod: [], scroll: 0, filter: '', searching: false, wrap: true, proc: null, timer: null, closed: false,
    gen: 0, retries: 0, endedAt: 0, msg: 'подключение…', selector: '', carryO: '', carryE: '',
    mode: 'one', podName: p.name, podInfo: { name: p.name, start: d ? d.start : '', phase: p.status, container: '', containers: d ? d.containers.length : 0 },
    podCount: 1, fmt: true, fmtGen: 0, fmode: 'hl', curRef: null, container: '' };
  ui.mode = 'logs';
  podLogsStart(ui.lv); draw();
}
async function chooseContainer(lv) {
  let res;
  try { res = await resolvePods(kubeconfigOf(lv.svc), lv.svc); }
  catch (e) { lv.msg = 'ошибка: ' + e.message; return draw(); }
  if (lv.closed) return;
  const list = res.pods[0].list || [];
  if (list.length < 2) { lv.msg = 'в поде один контейнер'; return draw(); }
  const cur = lv.container || res.pods[0].container;
  const c = await pick(`Контейнер пода ${lv.svc.service}`, list.map(n => ({ label: (n === cur ? '● ' : '  ') + n, value: n })), { current: cur });
  if (lv.closed) return;
  if (c) { lv.container = c; podLogsRestart(lv); }
  draw();
}
async function resolvePods(kc, s) {
  if (s.kind === 'pod') {
    const i = await kube(kc, ['-n', s.namespace, 'get', 'pod', s.service, '-o', 'json']);
    const list = (i.spec.containers || []).map(c => c.name);
    return { sel: '', pods: [{ name: i.metadata.name, start: i.status.startTime || '', phase: i.status.phase || '', container: mainContainer(i), containers: list.length, list }] };
  }
  return listPods(kc, s);
}

// ───────────────────────── логи пода (как в Lens) ─────────────────────────
const LOG_BUF = 5000;
const cleanLine = t => t.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\t/g, '  ').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

function openLogs() {
  const s = curSvc(); if (!s) return;
  ui.lv = { svc: s, src: 'pod', pod: [], scroll: 0, filter: '', searching: false, wrap: true, proc: null, timer: null, closed: false,
    gen: 0, retries: 0, endedAt: 0, msg: 'подключение…', selector: '', carryO: '', carryE: '',
    mode: null, podName: '', podInfo: null, podCount: 0, fmt: true, fmtGen: 0, fmode: 'hl', curRef: null }; // mode: null (ещё не выбрано) | 'one' | 'all'
  ui.mode = 'logs';
  podLogsStart(ui.lv); draw();
}
function closeLogs() {
  const lv = ui.lv; if (!lv) return;
  lv.closed = true; clearTimeout(lv.timer);
  if (lv.proc) { const p = lv.proc; lv.proc = null; try { p.kill(); } catch (_) {} }
  ui.lv = null; ui.mode = 'list'; draw();
}
function podLogsRestart(lv) {
  clearTimeout(lv.timer); lv.timer = null;
  if (lv.proc) { const p = lv.proc; lv.proc = null; try { p.kill(); } catch (_) {} }
  lv.pod = []; lv.scroll = 0; lv.retries = 0; lv.endedAt = 0; lv.carryO = lv.carryE = '';
  podLogsStart(lv);
}
function podRetry(lv) {
  lv.retries++;
  const delay = Math.min(3000 * lv.retries, 15000);
  lv.timer = setTimeout(() => { lv.timer = null; if (!lv.closed) podLogsStart(lv); }, delay);
}
function podFeed(lv, d, isErr) {
  const key = isErr ? 'carryE' : 'carryO';
  const parts = (lv[key] + d).split(/\r?\n/);
  lv[key] = parts.pop();
  if (!parts.length) return;
  for (const t of parts) lv.pod.push({ text: cleanLine(t), err: isErr });
  if (lv.pod.length > LOG_BUF) lv.pod.splice(0, lv.pod.length - LOG_BUF);
  if (lv.scroll > 0) lv.scroll += parts.length; // не «уплываем» от строки, пока читаем историю
  if (!isErr) lv.retries = 0;
  draw();
}
const ALL_PODS = { all: true };
const pad2 = n => String(n).padStart(2, '0');
function fmtStart(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  const abs = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const sec = Math.max(0, Math.round((Date.now() - d) / 1000));
  const ago = sec < 60 ? `${sec} с` : sec < 3600 ? `${Math.floor(sec / 60)} мин` : sec < 172800 ? `${Math.floor(sec / 3600)} ч` : `${Math.floor(sec / 86400)} дн`;
  return `${abs} (${ago} назад)`;
}
// без явного -c kubectl может отказаться читать лог пода с несколькими контейнерами,
// поэтому берём контейнер по умолчанию, а служебные sidecar-ы (istio и т.п.) пропускаем
function mainContainer(pod) {
  const cs = (pod.spec.containers || []).map(c => c.name);
  const def = (pod.metadata.annotations || {})['kubectl.kubernetes.io/default-container'];
  if (def && cs.includes(def)) return def;
  return cs.find(n => !/^(istio-proxy|linkerd-proxy|envoy.*|vault-agent.*)$/.test(n)) || cs[0] || '';
}
async function listPods(kc, s) {
  const svc = await kube(kc, ['-n', s.namespace, 'get', 'svc', s.service, '-o', 'json']);
  const sel = Object.entries(svc.spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(',');
  if (!sel) throw new Error('у сервиса нет selector, логи подов недоступны');
  const d = await kube(kc, ['-n', s.namespace, 'get', 'pods', '-l', sel, '-o', 'json']);
  const pods = d.items.map(i => ({
    name: i.metadata.name, start: i.status.startTime || '', phase: i.status.phase || '',
    container: mainContainer(i), containers: (i.spec.containers || []).length,
  })).sort((x, y) => (y.start || '').localeCompare(x.start || ''));
  return { sel, pods };
}
function podItems(pods) {
  const w = Math.max(...pods.map(p => p.name.length));
  return [
    { label: `Все поды (${pods.length}), с префиксом перед каждой строкой`, value: ALL_PODS },
    ...pods.map(p => ({ label: `${p.name.padEnd(w)}  ${p.phase.padEnd(9)} ${p.start ? 'запущен ' + fmtStart(p.start) : 'время старта неизвестно'}`, value: p })),
  ];
}
function useChoice(lv, choice) {
  if (choice === ALL_PODS) { lv.mode = 'all'; lv.podName = ''; lv.podInfo = null; }
  else { lv.mode = 'one'; lv.podName = choice.name; lv.podInfo = choice; }
}
async function podLogsStart(lv) {
  const s = lv.svc, kc = kubeconfigOf(s), my = ++lv.gen;
  lv.msg = 'ищу поды…'; draw();
  const stale = () => lv.closed || my !== lv.gen;
  let sel, pods;
  try { ({ sel, pods } = await resolvePods(kc, s)); }
  catch (e) {
    if (stale()) return;
    lv.msg = 'ошибка: ' + e.message + ' — повтор…';
    lv.pod.push({ text: '⚠ ' + e.message, sys: true });
    podRetry(lv); return draw();
  }
  if (stale()) return;
  lv.selector = sel; lv.podCount = pods.length;
  if (!pods.length) { lv.msg = 'у сервиса нет подов — повтор…'; podRetry(lv); return draw(); }

  if (lv.mode === 'one') {
    const cur = pods.find(x => x.name === lv.podName);
    if (cur) lv.podInfo = cur;
    else if (pods.length === 1) { useChoice(lv, pods[0]); lv.pod.push({ text: `↻ под заменён: ${pods[0].name}`, sys: true }); lv.endedAt = 0; }
    else { lv.podInfo = null; lv.msg = `под «${lv.podName}» исчез — нажмите P и выберите новый`; return draw(); }
  } else if (lv.mode === null) {
    if (pods.length === 1) useChoice(lv, pods[0]);
    else {
      lv.msg = 'выберите под'; draw();
      const choice = await pick(`Под сервиса ${s.service} (${pods.length})`, podItems(pods));
      if (stale()) return;
      if (!choice) return closeLogs();
      useChoice(lv, choice);
    }
  }
  streamLogs(lv, my, kc, sel, pods);
}
function streamLogs(lv, my, kc, sel, pods) {
  const s = lv.svc;
  const args = ['-n', s.namespace, 'logs'];
  if (lv.mode === 'all') args.push('-l', sel, '--prefix', '--max-log-requests=20');
  else { const pd = pods.find(x => x.name === lv.podName); args.push(lv.podName); const cont = lv.container || (pd && pd.container); if (cont) args.push('-c', cont); }
  args.push('-f');
  // при переподключении берём только то, что появилось с момента обрыва (чтобы не дублировать историю)
  if (lv.endedAt) args.push(`--since=${Math.ceil((Date.now() - lv.endedAt) / 1000) + 1}s`, '--tail=-1'); else args.push('--tail=300');
  if (kc) args.push('--kubeconfig=' + kc);
  let p;
  try { p = kspawn(args, { windowsHide: true }); }
  catch (e) { lv.msg = 'ошибка: ' + e.message; return draw(); }
  lv.proc = p; lv.msg = 'поток открыт'; draw();
  p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
  p.stdout.on('data', d => podFeed(lv, d, false));
  p.stderr.on('data', d => podFeed(lv, d, true));
  p.on('error', e => { if (lv.proc !== p) return; lv.msg = e.code === 'ENOENT' ? 'kubectl не найден в PATH' : e.message; draw(); });
  p.on('exit', code => {
    if (lv.proc !== p) return; // этот поток уже заменён или закрыт
    lv.proc = null; lv.endedAt = Date.now();
    for (const [k, err] of [['carryO', false], ['carryE', true]]) if (lv[k]) { lv.pod.push({ text: cleanLine(lv[k]), err }); lv[k] = ''; }
    lv.msg = `поток завершён (код ${code}), переподключение…`;
    podRetry(lv); draw();
  });
}
// P: сменить под во время просмотра
async function choosePod(lv) {
  if (lv.svc.kind === 'pod') return chooseContainer(lv);
  let res;
  try { res = await listPods(kubeconfigOf(lv.svc), lv.svc); }
  catch (e) { lv.msg = 'ошибка: ' + e.message; return draw(); }
  if (lv.closed) return;
  lv.podCount = res.pods.length;
  if (res.pods.length < 2) { lv.msg = res.pods.length ? 'у сервиса один под, выбирать не из чего' : 'у сервиса нет подов'; return draw(); }
  const choice = await pick(`Под сервиса ${lv.svc.service} (${res.pods.length})`, podItems(res.pods), { current: lv.mode === 'all' ? ALL_PODS : res.pods.find(x => x.name === lv.podName) });
  if (lv.closed) return;
  if (choice) { useChoice(lv, choice); podLogsRestart(lv); }
  draw();
}

function viewOf(lv, e) {
  if (e.vg !== lv.fmtGen) {
    e.vg = lv.fmtGen;
    e.view = (lv.fmt && !e.err && !e.sys && formatLog(e.text)) || [e];
  }
  return e.view;
}
function lvSource(lv) {
  const src = lv.src === 'pod' ? lv.pod.flatMap(e => viewOf(lv, e)) : rt(lv.svc).log.map(l => ({ text: l.t + ' ' + l.text, sys: l.sys }));
  const q = lv.filter.toLowerCase();
  return q && lv.fmode === 'filter' ? src.filter(l => l.text.toLowerCase().includes(q)) : src;
}

// ── поиск как в IntelliJ: подсветка всех совпадений, текущее ярче, счётчик, переходы, прокрутка «по центру»
const HL = '\x1b[30;48;5;179m', HL_CUR = '\x1b[1;30;48;5;208m';
function lvLayout(lv) {
  const n = Math.max(3, H - 4), width = Math.max(10, W - 2);
  const lines = lvSource(lv), rowStart = new Array(lines.length);
  let total = 0;
  for (let i = 0; i < lines.length; i++) { rowStart[i] = total; total += lv.wrap ? Math.max(1, Math.ceil(lines[i].text.length / width)) : 1; }
  return { n, width, lines, rowStart, total };
}
// все вхождения запроса: occ[i] — диапазоны в строке i, list — плоский список для навигации
function lvFind(lv, lines) {
  const occ = new Array(lines.length).fill(null), list = [];
  if (!lv.filter) return { occ, list };
  const re = new RegExp(lv.filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].text; let m, k = 0, arr = null;
    re.lastIndex = 0;
    while ((m = re.exec(t))) {
      (arr || (arr = [])).push([m.index, m.index + m[0].length]);
      list.push({ i, k, s: m.index }); k++;
      if (m[0].length === 0) re.lastIndex++;
    }
    occ[i] = arr;
  }
  return { occ, list };
}
const lvCurIdx = (lv, lines, list) => { const r = lv.curRef; return r ? list.findIndex(m => lines[m.i] === r.e && m.k === r.k) : -1; };
// Перейти к совпадению idx. Вокруг центра окна есть «зона покоя» (±60% от половины высоты): если совпадение внутри —
// просто подсвечиваем его, если снаружи (или не видно) — прокручиваем так, чтобы оно оказалось по центру.
function lvGoto(lv, L, F, idx) {
  const cnt = F.list.length;
  idx = ((idx % cnt) + cnt) % cnt;
  const m = F.list[idx];
  lv.curRef = { e: L.lines[m.i], k: m.k };
  if (L.total <= L.n) return; // весь лог на экране, прокручивать нечего
  const mrow = L.rowStart[m.i] + (lv.wrap ? Math.floor(m.s / L.width) : 0);
  const maxTop = L.total - L.n;
  const top = Math.max(0, Math.min(maxTop, maxTop - lv.scroll));
  const rel = mrow - top, c = (L.n - 1) / 2, band = 0.6 * (L.n / 2);
  if (rel >= 0 && rel < L.n && Math.abs(rel - c) <= band) return;
  const newTop = Math.max(0, Math.min(maxTop, Math.round(mrow - c)));
  lv.scroll = maxTop - newTop;
}
// запрос изменился: выбираем ближайшее к центру окна совпадение (ниже центра, а если таких нет — последнее)
function lvQueryChanged(lv) {
  const L = lvLayout(lv), F = lvFind(lv, L.lines);
  if (!F.list.length) { lv.curRef = null; return; }
  const maxTop = Math.max(0, L.total - L.n), top = Math.max(0, Math.min(maxTop, maxTop - lv.scroll));
  const pad = Math.max(0, L.n - L.total), centerRow = top + (L.n - 1) / 2 - pad;
  const rowOf = m => L.rowStart[m.i] + (lv.wrap ? Math.floor(m.s / L.width) : 0);
  let idx = F.list.findIndex(m => rowOf(m) >= centerRow);
  if (idx < 0) idx = F.list.length - 1;
  lvGoto(lv, L, F, idx);
}
// режим сменился: остаёмся на том же совпадении, если оно ещё есть
function lvKeep(lv) {
  const L = lvLayout(lv), F = lvFind(lv, L.lines), cur = lvCurIdx(lv, L.lines, F.list);
  if (cur >= 0) lvGoto(lv, L, F, cur); else lvQueryChanged(lv);
}
function lvStep(lv, d) {
  const L = lvLayout(lv), F = lvFind(lv, L.lines);
  if (!F.list.length) return;
  const cur = lvCurIdx(lv, L.lines, F.list);
  if (cur < 0) return lvQueryChanged(lv);
  lvGoto(lv, L, F, cur + d);
}
function addHl(row, text, off, ranges, curK, base) {
  let pos = 0;
  ranges.forEach(([a0, b0], k) => {
    const a = Math.max(a0 - off, pos), b = Math.min(b0 - off, text.length);
    if (b <= a) return;
    if (a > pos) row.add(text.slice(pos, a), base, undefined, true);
    row.add(text.slice(a, b), k === curK ? HL_CUR : HL, undefined, true);
    pos = b;
  });
  if (pos < text.length) row.add(text.slice(pos), base, undefined, true);
}
function lvStyle(l) {
  if (l.dim) return C.gray;
  if (l.lvl) {
    if (/^(ERROR|FATAL|SEVERE|CRITICAL|PANIC)/.test(l.lvl)) return C.red;
    if (/^WARN/.test(l.lvl)) return C.yellow;
    if (/^(DEBUG|TRACE)/.test(l.lvl)) return C.gray;
    return '';
  }
  if (l.err) return C.red;
  if (l.sys) return C.sys;
  if (/\b(ERROR|FATAL|PANIC|CRITICAL)\b|"level"\s*:\s*"(error|fatal|panic)"|\blevel=(error|fatal)\b/.test(l.text)) return C.red;
  if (/\b(WARN|WARNING)\b|"level"\s*:\s*"warn(ing)?"|\blevel=warn/.test(l.text)) return C.yellow;
  return '';
}
function renderLogs() {
  const lv = ui.lv, rows = [], s = lv.svc;
  const n = Math.max(3, H - 4), width = Math.max(10, W - 2);
  const head = new Row(0).add(` Логи: ${D(s.name)} `, C.title);
  if (lv.mode === 'all') head.add(` ⎈ все поды (${lv.podCount}) `, C.title);
  else if (lv.podName) {
    head.add(` ⎈ ${lv.podName} `, C.title);
    if (s.kind === 'pod' && lv.podInfo && lv.podInfo.containers > 1) head.add(` [${lv.container || lv.podInfo.container}] `, C.title);
    if (lv.podInfo && lv.podInfo.start) head.add(` запущен ${fmtStart(lv.podInfo.start)} `, C.title);
  } else head.add(` ${s.namespace}/${s.service} `, C.title);
  rows.push(head.fill(C.title));

  const lines = lvSource(lv);
  let total = 0;
  for (const l of lines) total += lv.wrap ? Math.max(1, Math.ceil(l.text.length / width)) : 1;
  lv.scroll = Math.max(0, Math.min(lv.scroll, Math.max(0, total - n)));
  const F = lv.filter ? lvFind(lv, lines) : null;
  const ci = F ? lvCurIdx(lv, lines, F.list) : -1;
  const curLine = ci >= 0 ? F.list[ci].i : -1, curK = ci >= 0 ? F.list[ci].k : -1;

  const tb = new Row(1).add(' ');
  const srcBtn = (id, label) => tb.add(` ${label} `, lv.src === id ? C.key : C.btn, () => { lv.src = id; lv.scroll = 0; draw(); }).add(' ');
  srcBtn('pod', '1 Под'); srcBtn('pf', '2 Port-forward');
  tb.add(lv.scroll > 0 ? ' ⏸ пауза ' : ' ● live ', lv.scroll > 0 ? C.yellow : C.green, () => { lv.scroll = 0; draw(); });
  tb.add(` ${lines.length} строк `, C.dim);
  if (lv.filter || lv.searching) {
    const fs_ = lv.searching ? C.inputF : C.input;
    tb.add(' ⌕ ', fs_, () => { lv.searching = true; draw(); });
    addInput(tb, lv, 'filter', 'fpos', 'foff', Math.max(10, Math.min(40, W - tb.x - 24)), fs_, lv.searching, () => { lv.searching = true; draw(); });
    tb.add(' ', fs_);
    if (F) tb.add(F.list.length ? ` ${ci >= 0 ? ci + 1 : '–'}/${F.list.length} ` : ' нет совпадений ', F.list.length ? C.green : C.red);
    tb.add(lv.fmode === 'filter' ? ' фильтр (Tab) ' : ' подсветка (Tab) ', C.dim);
  }
  if (lv.src === 'pod') tb.add(' ' + lv.msg, lv.proc ? C.gray : C.yellow);
  tb.fill(); rows.push(tb);

  // собираем n нижних экранных строк с учётом прокрутки и переноса
  const out = [];
  let skip = lv.scroll;
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const l = lines[i];
    const parts = [];
    if (lv.wrap) { for (let k = 0; k < Math.max(1, l.text.length); k += width) parts.push(l.text.slice(k, k + width)); }
    else parts.push(l.text.length > width ? l.text.slice(0, width - 1) + '…' : l.text);
    for (let j = parts.length - 1; j >= 0 && out.length < n; j--) {
      if (skip > 0) { skip--; continue; }
      out.push({ t: parts[j], l, i, off: lv.wrap ? j * width : 0 });
    }
  }
  out.reverse();
  for (let i = 0; i < n; i++) {
    const row = new Row(2 + i), o = out[i - (n - out.length)];
    if (o) {
      row.add(' ');
      const rg = F && F.occ[o.i];
      if (rg) addHl(row, o.t, o.off, rg, o.i === curLine ? curK : -1, lvStyle(o.l)); else row.add(o.t, lvStyle(o.l), undefined, !o.l.sys);
    }
    else if (!lines.length && i === 1) row.add(lv.src === 'pod' ? '  Ждём строки логов…' : '  В выводе port-forward пока пусто', C.gray);
    row.fill(); rows.push(row);
  }

  const btns = [
    { key: '↑↓', label: lv.filter ? 'Совпадения' : 'Прокрутка', fn: () => {} },
    { key: 'End', label: 'К концу', fn: () => { lv.scroll = 0; draw(); } },
    { key: '/', label: 'Поиск', fn: () => { lv.searching = true; draw(); } },
    { key: 'F', label: lv.fmt ? 'Формат: logback' : 'Формат: как есть', fn: () => { lv.fmt = !lv.fmt; lv.fmtGen++; lv.scroll = 0; draw(); } },
    { key: 'W', label: lv.wrap ? 'Не переносить' : 'Переносить', fn: () => { lv.wrap = !lv.wrap; draw(); } },
    { key: 'P', label: s.kind === 'pod' ? 'Контейнер' : 'Сменить под', fn: () => choosePod(lv) },
    { key: 'R', label: 'Перечитать', fn: () => { podLogsRestart(lv); draw(); } },
    { key: 'C', label: 'Очистить', fn: () => { lv.pod = []; lv.scroll = 0; draw(); } },
    { key: 'Tab', label: 'Источник', fn: () => { lv.src = lv.src === 'pod' ? 'pf' : 'pod'; lv.scroll = 0; draw(); } },
    { key: 'Esc', label: 'Назад', fn: closeLogs },
  ];
  const br = buttonRows(H - 2, btns);
  for (const r of br) { r.fill(); rows.push(r); }
  if (br.length < 2) rows.push(new Row(H - 1).add(' колесо / PgUp / PgDn / Home / End — прокрутка · в поиске: ↑↓ Enter F3 — совпадения, Tab — подсветка/фильтр, Esc — закрыть', C.gray).fill());
  return rows;
}
function logsKey(e) {
  const lv = ui.lv, n = Math.max(3, H - 4);
  if (lv.searching) {
    const was = lv.filter;
    switch (e.k) {
      case 'esc': lv.filter = ''; lv.fpos = 0; lv.searching = false; lv.curRef = null; return draw();
      case 'enter': case 'down': case 'f3': lvStep(lv, 1); return draw();
      case 'up': case 'sf3': lvStep(lv, -1); return draw();
      case 'pgup': lv.scroll += n - 1; return draw();
      case 'pgdn': lv.scroll = Math.max(0, lv.scroll - (n - 1)); return draw();
      case 'tab': lv.fmode = lv.fmode === 'hl' ? 'filter' : 'hl'; lvKeep(lv); return draw();
      case 'ctrl-c': return closeLogs();
      case 'bs': if (!lv.filter) { lv.searching = false; return draw(); } // иначе — обычное стирание
      // fallthrough
      default: if (edit(lv, 'filter', 'fpos', e) && lv.filter !== was) lvQueryChanged(lv);
    }
    return draw();
  }
  // вставка вне поиска сразу открывает его с вставленным текстом (например, UUID)
  if (e.k === 'paste') { lv.filter = e.text; lv.fpos = undefined; lv.searching = true; lvQueryChanged(lv); return draw(); }
  const ch = e.k === 'char' ? (LAT[e.ch.toLowerCase()] || e.ch.toLowerCase()) : '';
  switch (e.k) {
    case 'esc': if (lv.filter) { lv.filter = ''; lv.curRef = null; lv.scroll = 0; break; } return closeLogs();
    case 'ctrl-c': return closeLogs();
    case 'up': lv.scroll += 1; break;
    case 'down': lv.scroll = Math.max(0, lv.scroll - 1); break;
    case 'pgup': lv.scroll += n - 1; break;
    case 'pgdn': lv.scroll = Math.max(0, lv.scroll - (n - 1)); break;
    case 'home': lv.scroll = 1e9; break;
    case 'end': lv.scroll = 0; break;
    case 'tab': lv.src = lv.src === 'pod' ? 'pf' : 'pod'; lv.scroll = 0; break;
    case 'ctrl-f': lv.searching = true; break;
    case 'ctrl-u': lv.filter = ''; lv.curRef = null; lv.scroll = 0; break;
  }
  if (e.k === 'char' && e.ch === '/') lv.searching = true;
  if (e.k === 'char' && e.ch === '1') { lv.src = 'pod'; lv.scroll = 0; }
  if (e.k === 'char' && e.ch === '2') { lv.src = 'pf'; lv.scroll = 0; }
  if (ch === 'q') return closeLogs();
  if (ch === 'w') lv.wrap = !lv.wrap;
  if (ch === 'f') { lv.fmt = !lv.fmt; lv.fmtGen++; lv.scroll = 0; }
  if (ch === 'r') podLogsRestart(lv);
  if (ch === 'p') return choosePod(lv);
  if (ch === 'c') { lv.pod = []; lv.curRef = null; lv.scroll = 0; }
  draw();
}

// ───────────────────────── ввод ─────────────────────────
const KEYS = {
  '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\x1b[H': 'home', '\x1b[F': 'end',
  '\x1b[1~': 'home', '\x1b[4~': 'end', '\x1b[3~': 'del', '\x1b[5~': 'pgup', '\x1b[6~': 'pgdn', '\x1b[Z': 'stab',
  '\x1bOQ': 'f2', '\x1b[12~': 'f2', '\x1bOA': 'up', '\x1bOB': 'down', '\x1bOH': 'home', '\x1bOF': 'end', '\x1b[7~': 'home', '\x1b[8~': 'end',
  '\x1bOR': 'f3', '\x1b[13~': 'f3', '\x1b[1;2R': 'sf3', '\x1b[25~': 'sf3', '\x1b[1;5D': 'wleft', '\x1b[1;5C': 'wright', '\x1b[1;3D': 'wleft', '\x1b[1;3C': 'wright', '\x1b[2;2~': 'ctrl-v',
};
const TOKEN = /\x1b\[<(\d+);(\d+);(\d+)([Mm])|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1bO[A-Z]|\x1b|[\s\S]/gu;

const decoder = new (require('string_decoder').StringDecoder)('utf8');
let pasteBuf = null; // накопление текста между \x1b[200~ и \x1b[201~ (bracketed paste)
function onData(buf) {
  let str = decoder.write(buf);
  while (str.length) {
    if (pasteBuf !== null) {
      const i = str.indexOf('\x1b[201~');
      if (i < 0) { pasteBuf += str; return; }
      const text = cleanPaste(pasteBuf + str.slice(0, i));
      pasteBuf = null; str = str.slice(i + 6);
      if (text) onKey({ k: 'paste', text });
      continue;
    }
    const i = str.indexOf('\x1b[200~');
    if (i < 0) { onTokens(str); return; }
    onTokens(str.slice(0, i));
    pasteBuf = ''; str = str.slice(i + 6);
  }
}
function onTokens(str) {
  for (const m of str.matchAll(TOKEN)) {
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
    else if (t === '\x17') e = { k: 'ctrl-w' };
    else if (t === '\x16') e = { k: 'ctrl-v' };
    else if (t === '\x01') e = { k: 'home' };
    else if (t === '\x05') e = { k: 'end' };
    else if (t === '\x06') e = { k: 'ctrl-f' };
    else if (t === ' ') e = { k: 'space' };
    else if (t >= ' ' && t[0] !== '\x1b') e = { k: 'char', ch: t };
    else continue;
    onKey(e);
  }
}
function onMouse(b, x, y, press) {
  if (!press) return;
  if ((b & 64) && (b & 3) < 2) { // колесо (с любыми модификаторами Shift/Alt/Ctrl)
    const up = (b & 1) === 0, d = up ? 'up' : 'down';
    if (ui.mode === 'list') onKey({ k: d }); else if (ui.mode === 'picker') pickerKey({ k: d });
    else if (ui.mode === 'logs' && ui.lv) { ui.lv.scroll = Math.max(0, ui.lv.scroll + (up ? 3 : -3)); draw(); }
    return;
  }
  if (b !== 0) return;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.y === y && x >= h.x1 && x <= h.x2) { h.fn(); return; }
  }
}
function onKey(e) {
  if (e.k === 'ctrl-v') { readClipboard(t => { const text = cleanPaste(t); if (text) onKey({ k: 'paste', text }); }); return; }
  if (ui.mode === 'form') return formKey(e);
  if (ui.mode === 'picker') return pickerKey(e);
  if (ui.mode === 'logs') return logsKey(e);
  if (ui.mode === 'confirm') {
    const ch = e.k === 'char' ? (LAT[e.ch.toLowerCase()] || e.ch.toLowerCase()) : '';
    if (e.k === 'enter' || ch === 'y') return ui.confirm.yes();
    if (e.k === 'esc' || ch === 'n') return closeConfirm();
    return;
  }
  const isG = ui.tab === 'groups', isC = ui.tab === 'cluster';
  const sk = isG ? 'gsel' : isC ? 'psel' : 'sel';
  const n = isG ? groupsVisible().length : isC ? podsVisible().length : visible().length;
  const TABS = ['all', 'running', 'groups', 'cluster'];
  const setTab = t => { ui.tab = t; ui.sel = 0; ui.off = 0; ui.gsel = 0; ui.goff = 0; ui.psel = 0; ui.poff = 0; ui.pkey = ''; if (t === 'cluster') refreshPods(); };
  const nextTab = () => setTab(TABS[(TABS.indexOf(ui.tab) + 1) % TABS.length]);
  if (ui.searching) {
    switch (e.k) {
      case 'esc': ui.query = ''; ui.qpos = 0; ui.searching = false; ui[sk] = 0; break;
      case 'enter': ui.searching = false; break;
      case 'tab': nextTab(); break;
      case 'up': ui[sk] = Math.max(0, ui[sk] - 1); break;
      case 'down': ui[sk] = Math.min(n - 1, ui[sk] + 1); break;
      case 'ctrl-c': return quit();
      case 'bs': if (!ui.query) { ui.searching = false; break; } // иначе — обычное стирание
      // fallthrough
      default: { const was = ui.query; if (edit(ui, 'query', 'qpos', e) && ui.query !== was) ui[sk] = 0; }
    }
    return draw();
  }
  // вставка вне режима поиска сразу превращается в запрос
  if (e.k === 'paste') { ui.query = e.text; ui.qpos = undefined; ui.searching = false; ui[sk] = 0; return draw(); }
  const ch = e.k === 'char' ? (LAT[e.ch.toLowerCase()] || e.ch.toLowerCase()) : '';
  if (e.k === 'ctrl-c' || ch === 'q') return quit();
  switch (e.k) {
    case 'up': ui[sk] = Math.max(0, ui[sk] - 1); break;
    case 'down': ui[sk] = Math.min(n - 1, ui[sk] + 1); break;
    case 'pgup': ui[sk] = Math.max(0, ui[sk] - 8); break;
    case 'pgdn': ui[sk] = Math.min(n - 1, ui[sk] + 8); break;
    case 'home': ui[sk] = 0; break;
    case 'end': ui[sk] = Math.max(0, n - 1); break;
    case 'enter': case 'space': return isG ? toggleGroup(curGroup()) : isC ? podAction() : toggle();
    case 'del': if (isC) break; return isG ? askDeleteGroup() : askDelete();
    case 'tab': nextTab(); break;
    case 'ctrl-f': ui.searching = true; break;
    case 'esc': if (ui.query) { ui.query = ''; ui[sk] = 0; } break;
  }
  if (e.k === 'char' && e.ch === '/') ui.searching = true;
  if (e.k === 'char' && e.ch === '1') setTab('all');
  if (e.k === 'char' && e.ch === '2') setTab('running');
  if (e.k === 'char' && e.ch === '3') setTab('groups');
  if (e.k === 'char' && e.ch === '4') setTab('cluster');
  if (ch === 'k') return switchKubeconfig();
  if (ch === 'o') return openSettings();
  if (isG) {
    const g = curGroup();
    if (ch === 'a') return openGroupForm();
    if (ch === 'e' && g) return openGroupForm(g);
    if (ch === 'd') return askDeleteGroup();
    if (ch === 's' && g) members(g).forEach(start);
    if (ch === 'x' && g) members(g).forEach(stop);
  } else if (isC) {
    const pd = podsVisible()[ui.psel];
    if (ch === 'l' && pd) return openPodLogs(pd);
    if (ch === 'n') return chooseNamespace();
    if (ch === 'r') refreshPods();
    if (ch === 'f' && pd) return podToFavorite(pd);
    if (ch === 'p' && pd) return directForward(pd);
  } else {
    const cur = curSvc();
    if (ch === 'a') return openServiceForm();
    if (ch === 'e' && cur) return editService(cur);
    if (ch === 'd') return askDelete();
    if (ch === 'g') return saveRunningAsGroup();
    if (ch === 'l') return openLogs();
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
  const helpRu = `bftport ${require('./package.json').version} — менеджер kubectl port-forward

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
  L  логи пода на весь экран (как в Lens): один под — сразу, несколько — выбор
     со временем старта; в просмотре P — сменить под, / — поиск (как в IntelliJ: подсветка,
     счётчик, ↑↓/Enter/F3 — по совпадениям; Tab — режим «фильтр»), W — перенос,
     F — формат: JSON-логи приводятся к шаблону logback (~/.m2/logback-local.xml)
  /  или Ctrl+F  поиск (имя, namespace, service, порт, статус); Esc — сбросить
  Во всех полях ввода: ←→ Home End Del — курсор, Ctrl+←/→ — по словам, Ctrl+W — слово назад,
  Ctrl+U — очистить, Ctrl+V / Shift+Insert — вставить из буфера обмена
  1 2 3 4 / Tab  вкладки: Избранное, Запущенные, Шаблоны, Кластер
  G              сохранить запущенные сервисы как шаблон
  4 Кластер      все поды кластера без ручного добавления (только просмотр): поиск, проброс порта
                 пода (Enter; если под относится к сервису из избранного — запускается он, на своём порту),
                 напрямую к поду (P), логи (L), в избранное (F), смена namespace (N), обновление (R)
  K              выбор kubeconfig из папки (F2 в списке — сменить папку)
  O              настройки (папка kubeconfig, язык, о приложении)
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
  Чтобы сбросить всё к стартовому набору, удалите файл базы.`;
  console.log(UILANG === 'en' ? i18n.HELP_EN(VERSION, __dirname, DB_FILE) : helpRu);
  process.exit(0);
}
if (!process.stdin.isTTY) { console.error('Нужен интерактивный терминал'); process.exit(1); }

// bftport --keys: диагностика ввода — показывает сырые байты нажатий и кликов мыши
if (process.argv.includes('--keys')) {
  process.stdout.write('\x1b[?1000h\x1b[?1006h\x1b[?2004h');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  enableConsoleMouse();
  console.log(`terminal: ${process.env.WT_SESSION ? 'Windows Terminal' : process.env.TERM_PROGRAM || 'не Windows Terminal (conhost/другой)'}`);
  console.log('Кликайте мышью и жмите клавиши. Ничего не появляется при клике — мышь не доходит. Ctrl+C — выход.\r');
  process.stdin.on('data', d => {
    if (d.includes(3)) { process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l'); process.exit(0); }
    console.log(JSON.stringify(d.toString()) + '\r');
  });
  return;
}

process.stdout.write('\x1b[?1049h\x1b[?7l\x1b[?1000h\x1b[?1006h\x1b[?2004h');
process.stdin.setRawMode(true);
process.stdin.resume();
enableConsoleMouse();
process.stdin.on('data', onData);
process.stdout.on('resize', draw);
process.on('exit', killAll);
process.on('uncaughtException', e => {
  killAll();
  process.stdout.write('\x1b[?2004l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?25h\x1b[?1049l');
  console.error(e);
  process.exit(1);
});
db.services.filter(s => s.autostart).forEach(start);
render();
