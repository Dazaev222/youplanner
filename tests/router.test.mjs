// Подсветка нижнего таб-бара. Вкладка отвечает на вопрос «из какой вкладки
// сюда зашли», и ошибка в реестре SCREENS не видна ни в одном другом тесте:
// экран открывается правильный, подсвечена при этом чужая вкладка.
//
// Класс дефекта живой (2026-11-03): экраны статистики и «Матрица» открываются
// кнопкой на главной, а вкладка у них стояла 'settings' — шестерёнка
// подсвечивалась там, где человек в настройках не был.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';
import { readIndexHtml } from './helpers/sources.mjs';

const ctxOf = () => loadApp().context;

test('экраны, открытые с главной, подсвечивают «Главную»', (t) => {
  const ctx = ctxOf();
  for (const name of ['stats', 'stats-qaza', 'stats-habits', 'stats-habit',
    'stats-fast', 'stats-sleep', 'matrix']) {
    assert.equal(ctx.tabFor(name), 'main', name + ' — вход из меню на главной');
  }
});

test('экраны с входом из настроек подсвечивают «Настройки»', (t) => {
  const ctx = ctxOf();
  assert.equal(ctx.tabFor('edit-habits'), 'settings');
  assert.equal(ctx.tabFor('prayer-settings'), 'settings');
  assert.equal(ctx.tabFor('settings'), 'settings');
});

test('у «Цикла сна» два входа, и вкладка следует за входом', (t) => {
  const ctx = ctxOf();
  assert.equal(ctx.tabFor('sleep', 'settings'), 'settings', 'строка в Настройках');
  assert.equal(ctx.tabFor('sleep', 'main'), 'main', 'пункт меню на главной');
  assert.equal(ctx.tabFor('sleep'), 'main', 'без входа — как с главной');
});

test('разделы таб-бара подсвечивают свои вкладки', (t) => {
  const ctx = ctxOf();
  assert.equal(ctx.tabFor('main'), 'main');
  assert.equal(ctx.tabFor('qaza'), 'qaza');
  assert.equal(ctx.tabFor('prayer'), 'qaza', 'молитвы — внутри вкладки «Каза»');
  assert.equal(ctx.tabFor('fast'), 'qaza');
  assert.equal(ctx.tabFor('schedule'), 'schedule');
  assert.equal(ctx.tabFor('schedule-edit'), 'schedule',
    'редактор расписания — тот же раздел, а не «нигде»: без этого таб-бар на нём не подсвечивает ничего');
  assert.equal(ctx.tabFor('assistant'), 'assistant');
});

// Опечатка в name вкладки (например 'setings') не упала бы никогда: compare
// просто не совпал бы ни с одной кнопкой, и подсветка пропала бы на экране.
test('каждая вкладка реестра существует в разметке таб-бара', (t) => {
  const ctx = ctxOf();
  const views = new Set([...readIndexHtml().matchAll(/data-view="([^"]+)"/g)].map(m => m[1]));
  assert.ok(views.size >= 4, 'в разметке не найдено ни одной вкладки таб-бара');
  const names = ctx.screenNames();
  assert.ok(names.length, 'реестр SCREENS недоступен из песочницы');
  const unknown = [];
  for (const name of names) {
    const tab = ctx.tabFor(name, 'settings');
    if (!views.has(tab)) unknown.push(name + ' → ' + tab);
  }
  assert.deepEqual(unknown, [], 'вкладка не соответствует ни одной кнопке таб-бара');
});

test('неизвестное имя экрана не теряет вкладку молча', (t) => {
  const ctx = ctxOf();
  assert.equal(ctx.tabFor('no-such-screen'), 'no-such-screen',
    'имя возвращается как есть: switchAppView такой экран всё равно не откроет, '
    + 'а подсветка не должна начать врать за другое');
});
