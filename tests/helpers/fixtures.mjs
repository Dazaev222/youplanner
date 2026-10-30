// Фабрики тестовых объектов. Данные совпадают с прежними литералами;
// expected values остаются в самих тестах.

export function habit(overrides = {}) {
  return {
    id: 'h1',
    name: 'Фаджр',
    type: 'boolean',
    unit: '',
    goal: null,
    ...overrides,
  };
}

export function hostilePayload() {
  return '<img src=x onerror="alert(1)">';
}

// Копия версии 11 с согласованной парой realWake/realSleepMin.
// Согласованность: bed 23:30, fall 15 → засыпание 1425 мин.
// actualWake 06:00 → сон 375 мин; realWake 05:30 → факт 345 мин.
export function defaultBackup() {
  return {
    version: 11,
    exportedAt: '2026-10-23T20:00:00.000Z',
    habits: [habit()],
    records: { '2026-10-23': { h1: true } },
    qaza: {
      version: 3,
      cursor: 3,
      remaining: { fajr: 1, zuhr: 1, asr: 1, maghrib: 1, isha: 1 },
      history: [],
    },
    prayer: { lat: 43.38085, lng: 45.83479, madhhab: 'shafi', method: 'dum-chr' },
    fast: { version: 1, remaining: 5, history: [] },
    qazaLog: { version: 1, since: '2026-10-01', entries: [] },
    sleep: {
      version: 4,
      bed: '23:30',
      fall: 15,
      wake: '06:00',
      actualWake: '06:00',
      sleepMin: 375,
      realWake: '05:30',
      realSleepMin: 345,
      excluded: false,
      history: [],
    },
    schedule: { weekday: [], weekend: [], fasting: [], physical: [] },
  };
}
