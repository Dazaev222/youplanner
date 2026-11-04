// YP F9: сервис-воркер обещает офлайн-копию при 404/500 — и обязан её отдавать.
//
// Почему поведенческий, а не «по тексту файла»: обещание в комментарии и код
// расходятся молча. Тест загружает исходник sw.js в node:vm (sw.js —
// классический скрипт без импортов, приём тот же, что в
// tests/helpers/load-app.mjs, только для одного файла), подставляет self с
// сборщиком обработчиков, своими заглушками fetch и caches — и ЗОВЁТ
// обработчик `fetch` с событием, которое захватывает respondWith. Проверяется
// ровно то, до чего доживает браузер: какой ответ вернулся из respondWith и
// что легло в кэш.
//
// Ожидания от network-first политики:
//   * свежий ok-ответ уходит в браузер и кладётся в кэш копией (clone);
//   * HTTP 404/500 — в браузер идёт закэшированная рабочая копия (именно это
//     обещает комментарий в sw.js: неатомарный деплой или битый бэкенд не
//     должны показывать пользователю обломки, когда целая версия лежит в кэше);
//   * при 404/500 без кэша — исходный плохой ответ, а не выдуманная заглушка:
//     страница должна выглядеть сломанной, если целой её взять неоткуда;
//   * сетевое отклонение (офлайн) — кэш, как и раньше;
//   * firebase-запросы и не-GET обработчик не трогает вообще.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SW_SOURCE = readFileSync(join(ROOT, 'sw.js'), 'utf8');

function makeResponse(init) {
  const response = {
    ok: init.ok,
    status: init.status,
    url: init.url || '',
    tag: init.tag || '',
    // clone() — ДРУГОЙ объект: в кэш должно уходить копирование, а не тот же
    // ответ, который уходит браузеру (тело читается один раз).
    clone: () => makeResponse(Object.assign({}, init, { cloned: true })),
  };
  if (init.cloned) response.cloned = true;
  return response;
}

// cache — содержимое кэша по url; fetchImpl — что обещает сеть.
function loadSw(options) {
  const opts = options || {};
  const handlers = {};
  const cache = new Map((opts.cache || []).map((entry) => [entry.url, entry.response]));
  const puts = [];

  const sandbox = {
    self: {
      addEventListener: (type, fn) => {
        (handlers[type] || (handlers[type] = [])).push(fn);
      },
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      open: () => Promise.resolve({
        put: (request, response) => { puts.push({ url: request.url, response }); return Promise.resolve(); },
        addAll: () => Promise.resolve(),
      }),
      match: (request) => Promise.resolve(cache.get(request.url)),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    },
    fetch: opts.fetchImpl || (() => Promise.reject(new Error('нет сети (тест)'))),
    console,
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, context, { filename: 'sw.js' });
  return { handlers, puts };
}

// Событие fetch: захватывает respondWith и все waitUntil, чтобы тест мог
// дождаться и ответа, и побочных записей в кэш.
function fetchEvent(request) {
  const waits = [];
  let captured = null;
  return {
    request,
    respondWith(promise) { captured = Promise.resolve(promise); },
    waitUntil(promise) { waits.push(Promise.resolve(promise)); },
    get responded() { return captured !== null; },
    async settle() {
      const response = captured === null ? undefined : await captured;
      // записи в кэш идут мимо respondWith (waitUntil), поэтому ждём и их:
      // иначе тест проверял бы полуготовое состояние
      await Promise.all(waits);
      return { response };
    },
  };
}

function runFetch(sw, request) {
  const event = fetchEvent(request);
  for (const handler of sw.handlers.fetch || []) handler(event);
  return event;
}

const PAGE = { url: 'https://app.test/index.html', method: 'GET' };

test('F9: HTTP 500 отдаёт закэшированную рабочую копию, а не битый ответ', async () => {
  const cached = makeResponse({ ok: true, status: 200, url: PAGE.url, tag: 'кэш' });
  const broken = makeResponse({ ok: false, status: 500, url: PAGE.url, tag: 'сеть 500' });
  const sw = loadSw({
    cache: [{ url: PAGE.url, response: cached }],
    fetchImpl: () => Promise.resolve(broken),
  });

  const { response } = await runFetch(sw, PAGE).settle();
  assert.equal(response, cached, 'при 500 до браузера обязан дойти кэшированный ответ');
  assert.equal(sw.puts.length, 0, 'битый ответ в кэш не кладётся');
});

test('F9: 404 неатомарного деплоя тоже закрывается кэшированной копией', async () => {
  const cached = makeResponse({ ok: true, status: 200, url: 'https://app.test/js/app.js', tag: 'кэш' });
  const missing = makeResponse({ ok: false, status: 404, url: 'https://app.test/js/app.js', tag: 'сеть 404' });
  const sw = loadSw({
    cache: [{ url: 'https://app.test/js/app.js', response: cached }],
    fetchImpl: () => Promise.resolve(missing),
  });

  const { response } = await runFetch(sw, { url: 'https://app.test/js/app.js', method: 'GET' }).settle();
  assert.equal(response, cached, 'нового модуля нет, а старый рабочий есть — берём из кэша');
  assert.equal(sw.puts.length, 0);
});

test('F9: успешный ответ уходит в браузер и кладётся в кэш копией', async () => {
  const fresh = makeResponse({ ok: true, status: 200, url: PAGE.url, tag: 'сеть 200' });
  const sw = loadSw({ fetchImpl: () => Promise.resolve(fresh) });

  const { response } = await runFetch(sw, PAGE).settle();
  assert.equal(response, fresh, 'network-first: свежий ответ важнее кэша');
  assert.equal(sw.puts.length, 1, 'ok-ответ обязан обновить офлайн-копию');
  assert.equal(sw.puts[0].url, PAGE.url);
  assert.equal(sw.puts[0].response.cloned, true, 'в кэш кладётся clone(), а не сам ответ');
  assert.notEqual(sw.puts[0].response, fresh);
});

test('F9: офлайн (fetch отклонён) — отдаётся кэш, как и раньше', async () => {
  const cached = makeResponse({ ok: true, status: 200, url: PAGE.url, tag: 'кэш' });
  const sw = loadSw({
    cache: [{ url: PAGE.url, response: cached }],
    fetchImpl: () => Promise.reject(new Error('нет сети (тест)')),
  });

  const { response } = await runFetch(sw, PAGE).settle();
  assert.equal(response, cached);
});

test('F9: 404/500 без кэша — браузер видит настоящую ошибку, а не выдумку', async () => {
  const broken = makeResponse({ ok: false, status: 404, url: PAGE.url, tag: 'сеть 404' });
  const sw = loadSw({ fetchImpl: () => Promise.resolve(broken) });

  const { response } = await runFetch(sw, PAGE).settle();
  assert.equal(response, broken, 'заглушку вместо ответа выдумывать нельзя');
  assert.equal(response.status, 404);
  assert.equal(response.ok, false);
  assert.equal(sw.puts.length, 0, 'ошибка не должна становиться «рабочей» копией');
});

test('F9: firebase и не-GET обработчик не трогает', async () => {
  let networkCalls = 0;
  for (const request of [
    { url: 'https://yp-app.firebaseio.com/snapshot.json', method: 'GET' },
    { url: 'https://api.neuraldeep.ru/chat', method: 'POST' },
  ]) {
    const sw = loadSw({
      fetchImpl: () => {
        networkCalls++;
        return Promise.resolve(makeResponse({ ok: true, status: 200, url: request.url }));
      },
    });
    const event = runFetch(sw, request);
    await event.settle();
    assert.equal(event.responded, false, request.url + ': respondWith не вызывается');
    assert.equal(sw.puts.length, 0);
  }
  assert.equal(networkCalls, 0, 'эти запросы уходят в сеть мимо кэш-логики');
});

test('F9: статика вне html/js/css остаётся cache-first', async () => {
  const cached = makeResponse({ ok: true, status: 200, url: 'https://app.test/icon-512.png', tag: 'кэш' });
  let fetched = false;
  const sw = loadSw({
    cache: [{ url: 'https://app.test/icon-512.png', response: cached }],
    fetchImpl: () => { fetched = true; return Promise.resolve(makeResponse({ ok: true, status: 200 })); },
  });

  const { response } = await runFetch(sw, { url: 'https://app.test/icon-512.png', method: 'GET' }).settle();
  assert.equal(response, cached, 'иконка берётся из кэша без сети');
  assert.equal(fetched, false);
});
