'use strict';
// Английские тексты интерфейса. Исходные строки в bftport.js написаны по-русски, а при отрисовке (если выбран English)
// проходят через translate(): сначала правила с подстановкой чисел и имён, затем словарь фраз (самые длинные — первыми).
// Данные пользователя (имена, логи, ввод в полях) в translate не попадают — они выводятся как есть.

const CYR = '[А-Яа-яЁё]';
const HAS_CYR = new RegExp(CYR);

// [regexp, замена] — для текстов, где важен порядок слов или подставляются значения
const RULES = [
  [/Остановить (\d+) проброс\(ов\) и выйти\?/g, 'Stop $1 forward(s) and exit?'],
  [/Переключить на «([^»]*)»\? Будет остановлено пробросов: (\d+)/g, 'Switch to «$1»? Forwards to stop: $2'],
  [/порт (\d+) занят/g, 'port $1 is busy'],
  [/Порт (\d+) уже занят сервисом «/g, 'Port $1 is already used by service «'],
  [/«([^»]*)» уже в избранном/g, '«$1» is already in favorites'],
  [/\((\d+) (с|мин|ч|дн) назад\)/g, (m, n, u) => `(${n} ${{ 'с': 's', 'мин': 'min', 'ч': 'h', 'дн': 'd' }[u]} ago)`],
  [/(\d+) строк(?![А-Яа-яЁё])/g, '$1 lines'],
  [/(\d+) сервисов · (\d+) работает/g, '$1 services · $2 running'],
  [/у пода нет Service в namespace (\S+) — в избранное добавляются сервисы/g, 'the pod has no Service in namespace $1 — only services can be added to favorites'],
  [/под «([^»]*)» исчез — нажмите P и выберите новый/g, 'pod «$1» is gone — press P and choose a new one'],
  [/поток завершён \(код (\S+)\), переподключение…/g, 'stream ended (code $1), reconnecting…'],
  [/упал \(код (\S+)\), рестарт через ([\d.]+)с/g, 'crashed (code $1), restart in $2s'],
  [/Доступна версия (\S+)\. Обновляю…/g, 'Version $1 available. Updating…'],
  [/Установлена версия (\S+)\. Проверяю обновления…/g, 'Installed version $1. Checking for updates…'],
  [/Установлена актуальная версия \(([^)]*)\)\./g, 'You are on the latest version ($1).'],
  [/Установленная версия \(([^)]*)\) новее, чем в репозитории \(([^)]*)\)\. Обновление не требуется\./g, 'Installed version ($1) is newer than the repository ($2). No update needed.'],
  [/kubectl не ответил за (\d+) с/g, 'kubectl did not respond within $1 s'],
  [/Заполнено по поду (\S+) \(service (\S+)\)\. Проверьте и нажмите Enter\./g, 'Filled from pod $1 (service $2). Review and press Enter.'],
  [/Удалить шаблон «([^»]*)»\? \(сервисы останутся\)/g, 'Delete template «$1»? (services stay)'],
  [/Удалить «([^»]*)»\?/g, 'Delete «$1»?'],
  [/Обновление не удалось \(код /g, 'Update failed (code '],
  [/Не удалось получить версию из репозитория: /g, 'Could not get the version from the repository: '],
];

// [фраза, перевод]. Слова на границах проверяются, чтобы не задеть куски других слов.
const PHRASES = [
  // вкладки
  ['Избранное', 'Favorites'], ['Запущенные', 'Running'], ['Шаблоны', 'Templates'], ['Кластер', 'Cluster'],
  // колонки
  ['СЕРВИС', 'SERVICE'], ['ПОРТ', 'PORT'], ['СТАТУС', 'STATUS'], ['ШАБЛОН', 'TEMPLATE'], ['СОСТАВ', 'CONTENTS'],
  ['ИМЯ', 'NAME'], ['РЕСТ', 'RST'], ['ВОЗРАСТ', 'AGE'], ['ПРОБРОС', 'FORWARD'],
  // статусы
  ['запуск…', 'starting…'], ['рестарт', 'restarting'], ['работает', 'running'], ['ошибка: ', 'error: '], ['ошибка', 'error'], ['стоп', 'stopped'],
  // кнопки
  ['Да', 'Yes'], ['Нет', 'No'], ['Выход', 'Exit'], ['Назад', 'Back'], ['Поиск', 'Search'], ['Старт все', 'Start all'], ['Старт', 'Start'],
  ['Стоп все', 'Stop all'], ['Стоп проброса', 'Stop forward'], ['Стоп', 'Stop'], ['Конфиг', 'Config'], ['Отмена', 'Cancel'], ['Пробел', 'Space'],
  ['Добавить в избранное', 'Add to favorites'], ['Добавить', 'Add'], ['Изменить: ', 'Edit: '], ['Изменить', 'Edit'], ['Удалить', 'Delete'],
  ['В избранное', 'To favorites'], ['В шаблон', 'To template'], ['Создать', 'Create'], ['Обновить', 'Refresh'], ['Сохранить', 'Save'],
  ['Показать', 'Show'], ['Выбрать из кластера', 'Pick from cluster'], ['Выбрать порт пода', 'Select pod port'], ['Выбрать сервисы', 'Select services'],
  ['Выбрать', 'Select'], ['Отметить', 'Toggle'], ['Очистить', 'Clear'], ['Источник', 'Source'], ['К концу', 'To end'], ['Прокрутка', 'Scroll'],
  ['Совпадения', 'Matches'], ['Не переносить', 'No wrap'], ['Переносить', 'Wrap'], ['Перечитать', 'Reload'], ['Сменить под', 'Switch pod'],
  ['Контейнер пода ', 'Container of pod '], ['Контейнер', 'Container'], ['Логи пода', 'Pod logs'], ['Логи: ', 'Logs: '], ['Логи', 'Logs'],
  ['Формат: logback', 'Format: logback'], ['Формат: как есть', 'Format: raw'], ['Проброс (избранное)', 'Forward (favorite)'],
  ['Проброс порта пода ', 'Forward pod port '], ['Проброс порта', 'Forward port'], ['Пробросить', 'Forward'],
  ['Напрямую к поду (выбрать порт)', 'Directly to pod (choose port)'], ['Напрямую к поду', 'Directly to pod'],
  ['Запустить набор', 'Start set'], ['Остановить набор', 'Stop set'], ['Ввести вручную', 'Enter manually'], ['Папка с конфигами', 'Config folder'],
  ['Готово (', 'Done ('],
  // формы
  ['Новый сервис', 'New service'], ['Новый шаблон', 'New template'], ['Шаблон: ', 'Template: '], ['Название', 'Name'], ['Имя', 'Name'],
  ['Автозапуск', 'Autostart'], ['Локальный порт: число 1–65535', 'Local port: number 1–65535'], ['Локальный порт', 'Local port'],
  ['Порт пода: число 1–65535', 'Pod port: number 1–65535'], ['Порты пода: ', 'Pod ports: '], ['Порт пода', 'Pod port'], ['Порт сервиса', 'Service port'],
  ['Порт «', 'Port «'], ['пусто = все namespace', 'empty = all namespaces'], ['пусто = общий', 'empty = shared'],
  ['имя порта (grpc) или номер', 'port name (grpc) or number'], ['номер порта контейнера', 'container port number'],
  ['Папка с kubeconfig-файлами', 'Folder with kubeconfig files'], ['Папка с kubeconfig', 'kubeconfig folder'], ['Путь к папке', 'Folder path'],
  ['например ', 'e.g. '], ['Такой папки нет: ', 'No such folder: '], ['Укажите путь к папке', 'Enter a folder path'],
  ['Это путь от другой ОС — укажите путь для этой системы', 'This is a path from another OS — enter a path for this system'],
  ['пути к kubeconfig от другой ОС сброшены — выберите папку в настройках (O)', 'kubeconfig paths from another OS were reset — pick the folder in settings (O)'],
  ['После сохранения откроется список конфигов из этой папки', 'After saving, the list of configs from this folder will open'],
  ['Заполните имя, namespace, service и порт сервиса', 'Fill in name, namespace, service and service port'],
  ['Введите название шаблона', 'Enter a template name'], ['Выберите хотя бы один сервис (F2)', 'Select at least one service (F2)'],
  ['Шаблон с таким названием уже есть', 'A template with this name already exists'],
  ['Сервисы не выбраны — нажмите F2', 'No services selected — press F2'], ['Сервисы (', 'Services ('], ['Сервисы шаблона', 'Template services'],
  ['У пода нет объявленных портов', 'The pod has no declared ports'],
  ['У пода порты не объявлены — укажите порт вручную', 'The pod declares no ports — enter a port manually'],
  ['Сначала выберите kubeconfig (клавиша K в списке)', 'Choose a kubeconfig first (press K in the list)'],
  ['  Tab/↑↓ — поля · ←→ Home End — курсор · Ctrl+V — вставить · Ctrl+U — очистить · Пробел — галочка/выбор',
    '  Tab/↑↓ — fields · ←→ Home End — cursor · Ctrl+V — paste · Ctrl+U — clear · Space — toggle/choose'],
  ['  Tab/↑↓ — поля · ←→ Home End — курсор · Ctrl+V — вставить · Ctrl+U — очистить · Пробел — галочка',
    '  Tab/↑↓ — fields · ←→ Home End — cursor · Ctrl+V — paste · Ctrl+U — clear · Space — toggle'],
  // настройки
  ['Язык / Language', 'Language / Язык'], ['Настройки', 'Settings'], ['О приложении', 'About'], ['Версия:', 'Version:'],
  // списки и вкладки
  ['kubeconfig не выбран — нажмите K', 'kubeconfig not selected — press K'], ['kubeconfig не выбран (K)', 'kubeconfig not selected (K)'],
  ['  Пока пусто. Нажмите ', '  Nothing here yet. Press '], [' чтобы добавить сервис', ' to add a service'],
  ['  Нет запущенных сервисов — выберите вкладку «Избранное» и нажмите Enter', '  No running services — pick the «Favorites» tab and press Enter'],
  ['  Шаблонов нет. ', '  No templates. '], [' создать вручную или ', ' create manually or '],
  [' на вкладке «Избранное» — сохранить запущенные', ' on the «Favorites» tab to save the running ones'],
  ['  Ничего не найдено по запросу', '  Nothing found for the query'], ['  В выбранном namespace нет подов', '  No pods in the selected namespace'],
  ['  Загрузка подов из кластера…', '  Loading pods from the cluster…'], ['  Нет данных', '  No data'], ['  Загрузка…', '  Loading…'],
  ['  Список пуст', '  List is empty'], ['  Фильтр: ', '  Filter: '],
  ['  N — выбрать namespace (если нет прав на весь кластер) · R — повторить · K — другой конфиг',
    '  N — choose a namespace (if you lack cluster-wide permissions) · R — retry · K — another config'],
  ['поиск: / или Ctrl+F', 'search: / or Ctrl+F'], [' найдено: ', ' found: '],
  [' L — открыть на весь экран (логи пода) ', ' L — open full screen (pod logs) '], [' Детали', ' Details'], [' Состав', ' Contents'],
  ['подов', 'pods'], ['обновлено', 'updated'], ['обновление…', 'refreshing…'], ['только просмотр', 'read-only'],
  ['все namespace', 'all namespaces'], ['Все namespace', 'All namespaces'], ['узел: ', 'node: '], ['возраст: ', 'age: '],
  ['перезапусков: ', 'restarts: '], ['создан: ', 'created: '], ['★ избранное: ', '★ favorite: '], ['(уже в избранном)', '(already in favorites)'],
  ['загрузка подробностей…', 'loading details…'], ['не удалось получить подробности: ', 'failed to get details: '],
  ['не удалось получить данные пода: ', 'failed to get pod data: '], ['не удалось получить сервисы: ', 'failed to get services: '],
  ['нет ответа', 'no response'], ['порты не объявлены', 'no ports declared'], ['порты: ', 'ports: '], ['(без имени)', '(unnamed)'],
  ['(контейнер ', '(container '], ['время старта неизвестно', 'start time unknown'], ['запущен ', 'started '], [' · авто', ' · auto'],
  ['Все поды (', 'All pods ('], ['), с префиксом перед каждой строкой', '), with a prefix before each line'],
  [' ⎈ все поды (', ' ⎈ all pods ('], ['Под сервиса ', 'Pod of service '], ['Service пода ', 'Service of pod '], ['Service в «', 'Service in «'],
  ['Через какой сервис пробросить (', 'Forward through which service ('],
  ['это проброс из вкладки «Кластер»: его можно только остановить (Enter)', 'this is a forward from the «Cluster» tab: you can only stop it (Enter)'],
  // логи
  ['1 Под', '1 Pod'], [' ⏸ пауза ', ' ⏸ paused '], [' подсветка (Tab) ', ' highlight (Tab) '], [' фильтр (Tab) ', ' filter (Tab) '],
  [' нет совпадений ', ' no matches '], ['  Ждём строки логов…', '  Waiting for log lines…'],
  ['  В выводе port-forward пока пусто', '  No port-forward output yet'], ['поток открыт', 'stream open'], ['подключение…', 'connecting…'],
  ['ищу поды…', 'looking for pods…'], ['выберите под', 'choose a pod'], ['■ остановлен', '■ stopped'],
  ['у сервиса нет подов — повтор…', 'service has no pods — retrying…'], ['у сервиса нет подов', 'service has no pods'],
  ['у сервиса нет selector, логи подов недоступны', 'the service has no selector, pod logs are unavailable'],
  ['у сервиса один под, выбирать не из чего', 'the service has a single pod, nothing to choose'], ['в поде один контейнер', 'the pod has a single container'],
  ['↻ под заменён: ', '↻ pod replaced: '], ['под недоступен (возможно, удалён) · ', 'pod unavailable (possibly deleted) · '],
  [' — повтор…', ' — retrying…'],
  [' колесо / PgUp / PgDn / Home / End — прокрутка · в поиске: ↑↓ Enter F3 — совпадения, Tab — подсветка/фильтр, Esc — закрыть',
    ' wheel / PgUp / PgDn / Home / End — scroll · in search: ↑↓ Enter F3 — matches, Tab — highlight/filter, Esc — close'],
  // системные сообщения
  ['операция запрещена (только просмотр): kubectl ', 'operation not allowed (read-only): kubectl '], ['пустая команда kubectl', 'empty kubectl command'],
  ['kubectl не найден в PATH', 'kubectl not found in PATH'],
  ['ответ кластера слишком большой — сузьте выборку (N — namespace)', 'cluster response is too large — narrow the selection (N — namespace)'],
  ['Нужен интерактивный терминал', 'An interactive terminal is required'],
  ['В package.json не указан repository.url', 'repository.url is not set in package.json'],
  ['Проверьте доступ к репозиторию (git clone должен работать без ввода пароля) и наличие git в PATH.',
    'Check access to the repository (git clone must work without a password prompt) and that git is in PATH.'],
  ['Кликайте мышью и жмите клавиши. Ничего не появляется при клике — мышь не доходит. Ctrl+C — выход.',
    'Click the mouse and press keys. If nothing appears on click, the mouse does not reach the app. Ctrl+C — exit.'],
  ['не Windows Terminal (conhost/другой)', 'not Windows Terminal (conhost/other)'],
];

const lookbehind = p => (new RegExp('^' + CYR).test(p) ? `(?<!${CYR})` : '');
const lookahead = p => (new RegExp(CYR + '$').test(p) ? `(?!${CYR})` : '');
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAP = new Map(PHRASES);
const PHRASE_RE = new RegExp(
  [...MAP.keys()].sort((a, b) => b.length - a.length).map(p => lookbehind(p) + escapeRe(p) + lookahead(p)).join('|'), 'g');

// Пользовательские данные внутри фразы (имена сервисов, шаблонов, файлов) оборачиваются D(...): маркеры невидимы,
// а перевод такие куски не трогает — иначе имя «стоп-сервис» превратилось бы в «stopped-сервис».
const MARK = '\u2060';
const D = x => MARK + x + MARK;
const strip = t => String(t).replace(/\u2060/g, '');

function translate(text) {
  let r = String(text);
  const keep = [];
  r = r.replace(/\u2060([^\u2060]*)\u2060/g, (m, d) => { keep.push(d); return '\uE000' + (keep.length - 1) + '\uE001'; });
  if (HAS_CYR.test(r)) {
    for (const [re, to] of RULES) r = r.replace(re, to);
    r = r.replace(PHRASE_RE, m => MAP.get(m));
  }
  return r.replace(/\uE000(\d+)\uE001/g, (m, i) => keep[+i]);
}

const HELP_EN = (version, dir, dbFile) => `bftport ${version} — kubectl port-forward manager

USAGE
  bftport             start the interface (an interactive terminal is required)
  bftport --keys      input diagnostics: shows keys and mouse clicks
  bftport --update    check the repository for a new version and update
  bftport --version   version
  bftport --help      this help

FIRST RUN
  1. Press K, choose the folder with your kubeconfigs and pick the one you need.
  2. Select a service and press Enter to start a forward.
  3. Your own service: A. The «Pick from cluster» button (F2) fetches namespace,
     service and ports straight from the cluster.

KEYS (work on the Russian layout too; almost everything is clickable)
  ↑ ↓ / wheel / click   select              Enter / Space / double click   start / stop
  A  add                E  edit             D / Del  delete
  S  start all visible                      X  stop all visible
  L  pod logs full screen (like Lens): one pod — right away, several — a choice
     with start times; in the viewer P — switch pod, / — search (like IntelliJ: highlight,
     counter, ↑↓/Enter/F3 — through matches; Tab — «filter» mode), W — wrap,
     F — format: JSON logs are rendered with the logback pattern (~/.m2/logback-local.xml)
  /  or Ctrl+F  search (name, namespace, service, port, status); Esc — clear
  In all input fields: ←→ Home End Del — cursor, Ctrl+←/→ — by words, Ctrl+W — delete word,
  Ctrl+U — clear, Ctrl+V / Shift+Insert — paste from the clipboard
  1 2 3 4 / Tab  tabs: Favorites, Running, Templates, Cluster
  G              save the running services as a template
  4 Cluster      all pods of the cluster without adding them by hand (read-only): search, pod port
                 forward (Enter; if the pod belongs to a favorite service, that service is started
                 on its own port), directly to the pod (P), logs (L), to favorites (F),
                 namespace (N), refresh (R)
  K              choose a kubeconfig from the folder (F2 in the list — change the folder)
  O              settings (kubeconfig folder, language, about)
  Q / Ctrl+C     exit (forwards are stopped)

TEMPLATES
  A template is a named set of services. On the «Templates» tab Enter or a double
  click starts the whole set, pressing again stops it.
  The easiest way: start the services you need, press G and name the template.

ABOUT FORWARDS
  A dropped forward (for example when a pod restarts) is restarted automatically.
  If the local port is busy, the service shows an error and does not start.

FILES
  Installed in: ${dir}
  Database:     ${dbFile}
  To reset everything to the starter set, delete the database file.`;

module.exports = { translate, HELP_EN, HAS_CYR, D, strip };
