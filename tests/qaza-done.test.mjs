// Регрессия кнопки «Выполнено» на вкладке каза.
//
// Быстрый двойной клик/тап не должен списывать два намаза: первый клик
// перерисовывает план, и второй клик прилетает уже в новую кнопку на том же
// месте. Проверяем поведение обработчика, а не внутренний флаг: два вызова
// подряд обязаны дать ровно одно списание.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

test('«Выполнено»: двойной клик/тап списывает ровно один намаз', async () => {
  const app = loadApp();
  const qaza = app.context.loadQaza(true);
  app.context.setQazaState(qaza);

  const beforeTotal = app.context.qazaTotalRemaining(qaza);
  const beforeHistory = qaza.history.length;

  // Минимальный target: обработчику нужен только closest('#qaza-done').
  const event = {
    target: {
      closest(selector) {
        return selector === '#qaza-done' ? {} : null;
      },
    },
  };

  app.context.onQazaDone(event);
  // Второй клик приходит до снятия блокировки — это и есть двойной тап.
  app.context.onQazaDone(event);

  const after = app.context.getQazaState();
  assert.equal(app.context.qazaTotalRemaining(after), beforeTotal - 1,
    'двойной клик списал больше одного намаза');
  assert.equal(after.history.length, beforeHistory + 1,
    'двойной клик добавил больше одной записи в историю');
});
