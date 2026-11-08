// Дифференциальный гейт (АДР 2026-11-08, §5.2): старые фикстуры из HEAD^
// и текущая реализация HEAD применяются через applyCloudData; весь dump
// localStorage сравнивается побайтно (JSON с сортировкой ключей), плюс return
// value и события sync:applied / storage:error.

import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const LEGACY_REF = process.env.DIFF_LEGACY_REF || 'HEAD^';
const LEGACY_DIR = join(tmpdir(), 'youplanner-differential-' + process.pid + '-' + Date.now());
const K = {
  habits: 'youplanner.habits',
  records: 'youplanner.records',
  schedule: 'youplanner.schedule',
  archive: 'youplanner.archive',
  tombstones: 'youplanner.tombstones',
  qaza: 'youplanner.qaza',
  qazaLog: 'youplanner.qaza.log',
  fast: 'youplanner.qaza.fast',
  sleep: 'youplanner.sleep',
  sectionWrites: 'youplanner.sync.section-writes',
};
const HABIT_A = { id: 'h1', name: 'Чтение Корана', type: 'boolean', unit: '', goal: null };
const HABIT_B = { id: 'h2', name: 'Вода', type: 'boolean', unit: '', goal: null };
const QAZA_REMAINING = { fajr: 4, zuhr: 4, asr: 4, maghrib: 4, isha: 4 };

let oldLoadAppPromise = null;
let newLoadAppPromise = null;
let legacyWorktreeAdded = false;

async function importLoadApp(root, salt) {
  const url = pathToFileURL(join(root, 'tests', 'helpers', 'load-app.mjs')).href + '?v=' + salt;
  const mod = await import(url);
  return mod.loadApp;
}

async function initApps() {
  oldLoadAppPromise ??= importLoadApp(LEGACY_DIR, 'old-' + Date.now());
  newLoadAppPromise ??= importLoadApp(ROOT, 'new-' + Date.now());
  const old = await oldLoadAppPromise;
  const neW = await newLoadAppPromise;
  return { old, neW };
}

async function ensureLegacy() {
  if (legacyWorktreeAdded) return;
  rmSync(LEGACY_DIR, { recursive: true, force: true });
  execSync(`git worktree add --detach --force "${LEGACY_DIR}" "${LEGACY_REF}"`, { cwd: ROOT, stdio: 'pipe' });
  legacyWorktreeAdded = true;
}

async function makeApp(kind) {
  const loadApp = kind === 'old' ? (await oldLoadAppPromise) : (await newLoadAppPromise);
  const app = await loadApp({ fetchImpl: () => Promise.reject(new Error('offline')) });
  app.run(`
    globalThis.__applied = 0;
    globalThis.__storageError = 0;
    bus.on('sync:applied', function () { globalThis.__applied++; });
    bus.on('storage:error', function () { globalThis.__storageError++; });
  `);
  return app;
}

function seed(app, seedMap) {
  for (const key of Object.keys(seedMap)) {
    const value = seedMap[key];
    app.sandbox.localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

function failOnNthSetItem(storage, n) {
  const original = storage.setItem;
  const state = { calls: 0 };
  storage.setItem = function (key, value) {
    state.calls += 1;
    if (state.calls === n) {
      const error = new Error('QuotaExceededError');
      error.name = 'QuotaExceededError';
      throw error;
    }
    return original(key, value);
  };
}

function sortedDump(app) {
  const dump = app.sandbox.localStorage._dump();
  const sorted = {};
  for (const key of Object.keys(dump).sort()) sorted[key] = dump[key];
  return JSON.stringify(sorted);
}

async function runApply(kind, cloud, local, opts = {}) {
  const app = await makeApp(kind);
  seed(app, local);
  if (opts.sectionWrites) seed(app, { [K.sectionWrites]: JSON.stringify(opts.sectionWrites) });
  if (opts.pending) app.context.markSyncPending();
  app.run(`
    globalThis.__applied = 0;
    globalThis.__storageError = 0;
    bus.on('sync:applied', function () { globalThis.__applied++; });
    bus.on('storage:error', function () { globalThis.__storageError++; });
  `);
  const result = app.context.applyCloudData(cloud, opts.ts || 1000);
  const value = {
    after: sortedDump(app),
    result,
    applied: app.run('globalThis.__applied'),
    storageError: app.run('globalThis.__storageError'),
  };
  return value;
}

const CLOUD_FULL = {
  updatedAt: 1000,
  habits: [HABIT_A],
  records: { '2026-10-25': { h1: true } },
  qaza: { version: 3, cursor: 0, remaining: QAZA_REMAINING, history: [] },
  prayer: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' },
  fast: { version: 1, remaining: 9, history: [] },
  qazaLog: { version: 1, since: '2026-10-05', entries: [] },
  sleep: {
    version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375,
    realWake: '06:00', realSleepMin: 345, excluded: false, history: [],
  },
  schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
};

const LOCAL_FULL = {
  [K.habits]: [HABIT_B],
  [K.records]: { '2026-10-20': { h2: true } },
  [K.qaza]: { version: 3, cursor: 3, remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 }, history: [] },
  [K.prayer]: { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' },
  [K.fast]: { version: 1, remaining: 2, history: [{ date: '2026-10-01', count: 1, source: 'done' }] },
  [K.qazaLog]: { version: 1, since: '2026-10-01', entries: [{ date: '2026-10-02', namaz: 'fajr', source: 'done' }] },
  [K.sleep]: {
    version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375,
    realWake: '06:00', realSleepMin: 375, excluded: false,
    history: [{ date: '2026-10-20', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 }],
  },
  [K.schedule]: { weekday: [{ time: '07:00', text: 'Зарядка' }], weekend: [], fasting: [], physical: [] },
};

async function main() {
  await ensureLegacy();
  const { old, neW } = await initApps();
  void old;
  void neW;

  const results = [];

  async function check(name, cloud, local, opts = {}, quotaNth = null) {
    if (quotaNth) {
      const oldApp = await makeApp('old');
      seed(oldApp, local);
      const before = sortedDump(oldApp);
      failOnNthSetItem(oldApp.sandbox.localStorage, quotaNth);
      const oldResult = oldApp.context.applyCloudData(cloud, opts.ts || 1000);
      const after = sortedDump(oldApp);
      const oldValue = { after, result: oldResult, applied: 0, storageError: 0 };

      const newApp = await makeApp('new');
      seed(newApp, local);
      failOnNthSetItem(newApp.sandbox.localStorage, quotaNth);
      const newResult = newApp.context.applyCloudData(cloud, opts.ts || 1000);
      const newValue = { after: sortedDump(newApp), result: newResult, applied: 0, storageError: 0 };

      const ok = JSON.stringify(oldValue) === JSON.stringify(newValue) && oldResult === newResult;
      results.push({ name, ok, old: oldValue, new: newValue });
      return;
    }

    const oldValue = await runApply('old', cloud, local, opts);
    const newValue = await runApply('new', cloud, local, opts);
    const ok = JSON.stringify(oldValue) === JSON.stringify(newValue) && oldValue.result === newValue.result;
    results.push({ name, ok, old: oldValue, new: newValue });
  }

  await check('full-valid-snapshot', CLOUD_FULL, LOCAL_FULL, { ts: 1000 });
  await check('habits-empty-server-skip', { updatedAt: 1000, habits: [], records: {}, qaza: null, prayer: null, fast: null, qazaLog: null, sleep: null, schedule: null }, { [K.habits]: [HABIT_A], [K.records]: { '2026-10-20': { h2: true } } }, { ts: 1000 });
  await check('qaza-envelope-newer-apply', { updatedAt: 1000, sectionTs: { qaza: 2000 }, qaza: { v: { version: 3, cursor: 0, remaining: QAZA_REMAINING, history: [] }, ts: 2000 } }, { [K.qaza]: { version: 3, cursor: 3, remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 }, history: [] } }, { ts: 1000 });
  await check('qaza-envelope-older-skip', { updatedAt: 1000, sectionTs: { qaza: 1000 }, qaza: { v: { version: 3, cursor: 0, remaining: QAZA_REMAINING, history: [] }, ts: 1000 } }, { [K.qaza]: { version: 3, cursor: 3, remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 }, history: [] } }, { ts: 1000, sectionWrites: { qaza: 2000 } });
  await check('prayer-envelope-newer-apply', { updatedAt: 1000, sectionTs: { prayer: 2000 }, prayer: { v: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' }, ts: 2000 } }, { [K.prayer]: { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' } }, { ts: 1000 });
  await check('prayer-envelope-older-skip', { updatedAt: 1000, sectionTs: { prayer: 1000 }, prayer: { v: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' }, ts: 1000 } }, { [K.prayer]: { lat: 40.5, lng: 50.5, madhhab: 'hanafi', method: 'astro' } }, { ts: 1000, sectionWrites: { prayer: 2000 } });
  await check('fast-normalize-broken-history', { updatedAt: 1000, fast: { v: { version: 1, remaining: 9, history: [{ date: 'bad', count: 1, source: 'done' }] }, ts: 2000 } }, { [K.fast]: { version: 1, remaining: 2, history: [{ date: '2026-10-01', count: 1, source: 'done' }] } }, { ts: 1000 });
  await check('sleep-normalize-broken-history', { updatedAt: 1000, sleep: { version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375, realWake: '06:00', realSleepMin: 345, excluded: false, history: [{ date: 'bad', bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375 }] } }, { [K.sleep]: { version: 4, bed: '23:30', fall: 15, wake: '06:00', actualWake: '06:00', sleepMin: 375, realWake: '06:00', realSleepMin: 345, excluded: false, history: [] } }, { ts: 1000 });
  await check('schedule-envelope-always-apply', { updatedAt: 1000, sectionTs: { schedule: 2000 }, schedule: { v: { weekday: [{ time: '08:00', text: 'Отдых' }], weekend: [], fasting: [], physical: [] }, ts: 2000 } }, { [K.schedule]: { weekday: [{ time: '07:00', text: 'Зарядка' }], weekend: [], fasting: [], physical: [] } }, { ts: 1000 });
  await check('tombstones-merge-apply', { updatedAt: 1000, habits: [HABIT_A], tombstones: { h1: 200 } }, { [K.habits]: [HABIT_A], [K.tombstones]: { h1: 100 } }, { ts: 1000 });
  await check('pending-qaza-and-qazaLog-skip', { updatedAt: 1000, qaza: { version: 3, cursor: 0, remaining: QAZA_REMAINING, history: [] }, qazaLog: { version: 1, since: '2026-10-05', entries: [{ date: '2026-10-06', namaz: 'isha', source: 'done' }] } }, { [K.qaza]: { version: 3, cursor: 3, remaining: { fajr: 2, zuhr: 2, asr: 2, maghrib: 2, isha: 2 }, history: [] }, [K.qazaLog]: { version: 1, since: '2026-10-01', entries: [{ date: '2026-10-02', namaz: 'fajr', source: 'done' }] } }, { ts: 1000, pending: true });
  await check('quota-rolled-back', CLOUD_FULL, LOCAL_FULL, { ts: 1000 }, 2);
  await check('archive-replace', { updatedAt: 1000, archive: { version: 1, sleep: { months: {} }, fast: { months: {} }, qaza: { months: {} }, records: { months: {} } } }, { [K.archive]: { version: 1, sleep: { months: { '2026-10': { days: 1, totalMin: 500 } } }, fast: { months: {} }, qaza: { months: {} }, records: { months: {} } } }, { ts: 1000 });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.ok ? '' : '  old=' + JSON.stringify(r.old) + '  new=' + JSON.stringify(r.new)));
  }
  console.log(`Differential: ${results.length - failed}/${results.length} scenarios identical`);
  if (failed > 0) process.exit(1);
}

try {
  await main();
} finally {
  if (legacyWorktreeAdded) {
    try { execSync(`git worktree remove --force "${LEGACY_DIR}"`, { cwd: ROOT, stdio: 'pipe' }); } catch (e) { /* ignore */ }
  }
  try { rmSync(LEGACY_DIR, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}
