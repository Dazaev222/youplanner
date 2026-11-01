// Тесты кнопки «Анализ привычек» (js/ui/assistant-analysis.js).
//
// Снимок статистики собирается из живого состояния модулей данных, поэтому
// тесты идут через песочницу loadApp: сидируется localStorage, кэш записей
// инвалидируется, дальше проверяется текст реплики. Цифры в реплике обязаны
// совпадать с экраном «Статистика» — считаются теми же функциями stats.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

// Фиксированное «сегодня»: 2026-11-01. Окно анализа — 2026-10-03..11-01.
const TODAY = new Date(2026, 10, 1);
const HABITS = [
  { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
  { id: 'h6', name: 'Каза', type: 'number', unit: 'раз', goal: 3 },
  { id: 'h8', name: 'Коран', type: 'number', unit: 'стр.', goal: 5 },
];

// 13 дней подряд (2026-10-20..11-01): у h1 — true, у h8 — значения с одной
// недобранной целью, у каза h6 — по 2 намаза (1 ноября — один)
function seed(sandbox, context) {
  const records = {};
  for (let d = 20; d <= 31; d++) {
    const iso = '2026-10-' + String(d).padStart(2, '0');
    records[iso] = { h1: true, h6: 2, h8: 5 };
  }
  records['2026-11-01'] = { h1: true, h6: 1, h8: 3 };
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  sandbox.localStorage.setItem('youplanner.habits', JSON.stringify(HABITS));
  sandbox.localStorage.setItem('youplanner.qaza', JSON.stringify(5));
  sandbox.localStorage.setItem('youplanner.qaza.fast', JSON.stringify({ count: 12 }));
  sandbox.localStorage.setItem('youplanner.sleep', JSON.stringify({ bed: '23:00' }));
  // Записи могли уже попасть в кэш records.js при старте песочницы
  context.invalidateRecordsCache();
}

test('анализ: снимок считает серию, лучшую серию и окно как экран статистики', () => {
  const { sandbox, context } = loadApp();
  seed(sandbox, context);

  const snapshot = context.buildHabitsAnalysisSnapshot(TODAY);
  assert.ok(snapshot.indexOf('Привычки за последние 30 дней:') === 0,
    'снимок начинается с заголовка окна: ' + snapshot);
  // Фаджр: все 13 засеянных дней отмечены подряд по сегодня
  assert.ok(snapshot.indexOf('«Фаджр»: серия 13 дн., лучшая 13, отмечено 13/30') !== -1,
    'строка Фаджра: ' + snapshot);
  // Коран: отмечено столько же дней, серия та же; процент не проверяем точно —
  // формула calcProgress (вес/цель) принадлежит records.js
  assert.ok(snapshot.indexOf('«Коран» (цель 5 стр.): серия 13 дн.') !== -1,
    'строка Корана: ' + snapshot);
  // Каза: отдельная строка, привычка h6 из списка привычек исключена
  assert.ok(snapshot.indexOf('Каза-намазы: серия 13 дн., выполнено 25 за 30 дней, в очереди 5') !== -1,
    'строка каза: ' + snapshot);
  assert.ok(snapshot.indexOf('«Каза» (цель') === -1,
    'казу нельзя считать дважды: в списке привычек и отдельной строкой');
  // Ураза и сон — компактные разделы из хранилища
  assert.ok(snapshot.indexOf('Ураза: ') !== -1);
  assert.ok(snapshot.indexOf('Сон: ') !== -1);
});

test('анализ: пустое хранилище — честная фраза вместо выдуманных цифр', () => {
  const { context } = loadApp();
  const snapshot = context.buildHabitsAnalysisSnapshot(TODAY);
  assert.equal(snapshot, 'Записей пока нет — статистики для анализа нет.');
  const request = context.buildHabitsAnalysisRequest(TODAY);
  assert.ok(request.indexOf('Сделай анализ моих привычек.') === 0);
  assert.ok(request.indexOf('Записей пока нет') !== -1);
});

test('анализ: реплика = команда + снимок + формат ответа с эмодзи, потолок длины', () => {
  const { sandbox, context } = loadApp();
  seed(sandbox, context);
  const snapshot = context.buildHabitsAnalysisSnapshot(TODAY);
  const request = context.buildHabitsAnalysisRequest(TODAY);
  assert.ok(request.indexOf('Сделай анализ моих привычек.') === 0);
  assert.ok(request.indexOf(snapshot) !== -1, 'снимок целиком внутри реплики');
  assert.ok(request.indexOf('💪') !== -1 && request.indexOf('⚠️') !== -1
    && request.indexOf('🎯') !== -1, 'формат ответа с эмодзи задан');
  assert.ok(request.length <= 3000, 'реплика не раздувает историю: ' + request.length);
});

test('анализ: кнопка с data-action=analysis отправляет собранную реплику', async () => {
  let resolveReply;
  const fetchImpl = () => new Promise((resolve) => { resolveReply = resolve; });
  const { sandbox, context } = loadApp({ fetchImpl });
  seed(sandbox, context);
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');

  const chip = {
    getAttribute: (name) => (name === 'data-action' ? 'analysis' : null),
  };
  context.onAssistantChipClick({ target: { closest: () => chip } });
  if (resolveReply) resolveReply('АНАЛИЗ ГОТОВ');

  const raw = sandbox.localStorage.getItem('youplanner.assistant_history');
  const history = JSON.parse(raw || '[]');
  assert.ok(history.some((m) => m.role === 'user'
    && m.content.indexOf('Сделай анализ моих привычек.') === 0
    && m.content.indexOf('Каза-намазы') !== -1),
    'в историю ушла реплика с живой статистикой: ' + raw);
});

test('анализ: обычные чипы не перехватываются, мусорный event молчалив', () => {
  const { sandbox, context } = loadApp();
  sandbox.localStorage.setItem('youplanner.api_key', 'тест-ключ');

  const plainChip = { getAttribute: (name) => (name === 'data-chip' ? 'Сводка недели' : null) };
  context.onAssistantChipClick({ target: { closest: () => plainChip } });
  const history = JSON.parse(sandbox.localStorage.getItem('youplanner.assistant_history') || '[]');
  assert.ok(history.some((m) => m.role === 'user' && m.content === 'Сводка недели'),
    'обычный чип шлёт свой data-chip');

  // closest вернул null — обработчик молчит, ничего не падает и не отправляет
  context.onAssistantChipClick({ target: { closest: () => null } });
  const after = JSON.parse(sandbox.localStorage.getItem('youplanner.assistant_history') || '[]');
  assert.equal(after.length, history.length, 'мусорный event не пишет в историю');
});

// ── Аудит 2026-11-01: мусор в хранилище не должен ронять снимок и не должен ──
// превращаться в выдуманные цифры (бэкап/синхронизация пишут в те же ключи).

test('анализ: даты-мусор, привычка без имени, каза строкой, sleep строкой — честная деградация', () => {
  const { sandbox, context } = loadApp();
  const records = {};
  // 8 дней подряд в окне: 2026-10-25..11-01
  for (let d = 25; d <= 31; d++) {
    records['2026-10-' + String(d).padStart(2, '0')] = { h1: true, h6: 2 };
  }
  records['2026-11-01'] = { h1: true, h6: 1 };
  records['2026-13-45'] = { h1: true };   // несуществующая дата
  records['прошлая неделя'] = { h1: true };   // ключ не ISO-даты
  records['2026-10-40'] = { h1: true };   // несуществующий день месяца
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([
    { id: 'h6', name: null, type: 'number' },        // каза-привычка без имени
    { id: 'h1', name: 'Фаджр', type: 'boolean', unit: '', goal: null },
    { id: 'h9', name: 'Коран', type: 'number', unit: 'стр.', goal: null },
  ]));
  sandbox.localStorage.setItem('youplanner.qaza', JSON.stringify('5'));   // строка вместо числа
  sandbox.localStorage.setItem('youplanner.sleep', JSON.stringify('строка вместо объекта'));
  context.invalidateRecordsCache();

  const snapshot = context.buildHabitsAnalysisSnapshot(TODAY);

  // Никаких «undefined»/«null» в человеческом тексте
  assert.ok(snapshot.indexOf('undefined') === -1, 'undefined просочился: ' + snapshot);
  assert.ok(snapshot.indexOf('null') === -1, 'null просочился: ' + snapshot);
  // Привычка без имени пропущена, живая — посчитана (8 дней серия)
  assert.ok(snapshot.indexOf('«Фаджр»: серия 8 дн.') !== -1, 'строка Фаджра: ' + snapshot);
  // Каза: очередь строкой не превращается в ложную цифру «в очереди 5»
  assert.ok(snapshot.indexOf('Каза-намазы: серия 8 дн., выполнено 15 за 30 дней') !== -1,
    'строка каза: ' + snapshot);
  assert.ok(snapshot.indexOf('в очереди') === -1,
    'строковая очередь не должна попадать в снимок как число');
  // Сон-строка выводится как есть (компактный JSON), без падения
  assert.ok(snapshot.indexOf('Сон: ') !== -1, 'сон-строка должна остаться разделом');
  // Запрос целиком собирается
  assert.ok(context.buildHabitsAnalysisRequest(TODAY).indexOf(snapshot) !== -1);
});

test('анализ: привычка без id не роняет расчёт серии и прогресса', () => {
  const { sandbox, context } = loadApp();
  const records = {};
  for (let d = 25; d <= 31; d++) {
    records['2026-10-' + String(d).padStart(2, '0')] = { h1: true };
  }
  records['2026-11-01'] = { h1: true };
  sandbox.localStorage.setItem('youplanner.records', JSON.stringify(records));
  sandbox.localStorage.setItem('youplanner.habits', JSON.stringify([
    { id: null, name: 'Без id', type: 'boolean' },
    { id: 'h1', name: 'Фаджр', type: 'boolean' },
  ]));
  context.invalidateRecordsCache();

  const snapshot = context.buildHabitsAnalysisSnapshot(TODAY);
  assert.ok(snapshot.indexOf('«Фаджр»: серия 8 дн.') !== -1, 'живая привычка посчитана');
  assert.ok(!snapshot.includes('undefined'), 'undefined просочился: ' + snapshot);
});
