// Тесты общей логики строк списка привычек (js/ui/habits-edit.js, этап D.5).
//
// Модалка и экран «Привычки» раньше держали по дословной копии сборки patch
// (и подтверждения удаления); теперь patch собирает одна функция
// buildHabitPatch. Контракт: имя триммится; время попадает в patch только
// у привычек с уровнями (Коран — h8, см. QURAN_HABIT_ID); тип — только пока
// по привычке нет записей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

test('buildHabitPatch: имя триммится, время у обычной привычки не ставится', () => {
  const app = loadApp();
  const patch = app.context.buildHabitPatch('h-custom', {
    name: '  Пресс  ', type: 'number', unit: 'раз', goal: 10, time: null,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(patch)), {
    name: 'Пресс', unit: 'раз', goal: 10, type: 'number',
  }, 'лишних ключей (time) у привычки без уровней быть не должно');
});

test('buildHabitPatch: уровневой привычке время ставится, тип — пока нет записей', () => {
  const app = loadApp();
  const patch = app.context.buildHabitPatch('h8', {
    name: 'Коран', type: 'choice', unit: '', goal: null, time: '07:30',
  });
  const plain = JSON.parse(JSON.stringify(patch));
  assert.equal(plain.time, '07:30', 'время должно попасть в patch у уровневой привычки');
  assert.equal(plain.type, 'choice', 'пока записей нет, тип можно менять');
});
