import test from 'node:test';
import assert from 'node:assert/strict';
import { settingsLinks, importSummary, statisticPeriod, periodStreaks } from '../js/harness/diary-ui/settings.js';
test('серия и рекорд доступны и в «Текущем месяце» из данных сервиса', () => {
  const projection = { currentMs: 7000, bestMs: 9000, periods: { allTime: { currentMs: 7000, bestMs: 9000 }, currentMonth: { relapseCount: 2 } } };
  assert.deepEqual(periodStreaks(projection, 'allTime'), { currentMs: 7000, bestMs: 9000 });
  assert.deepEqual(periodStreaks(projection, 'currentMonth'), { currentMs: 7000, bestMs: 9000 });
  const own = { currentMs: 1, bestMs: 2, periods: { allTime: { currentMs: 3, bestMs: 4 }, currentMonth: { currentMs: 5, bestMs: 6 } } };
  assert.deepEqual(periodStreaks(own, 'currentMonth'), { currentMs: 5, bestMs: 6 });
});
test('настройки имеют отдельные маршруты и периоды сервиса не смешиваются',()=>{
 assert.deepEqual(settingsLinks.map(x=>x[0]),['history','statistics','triggers','analysis','export','import']);
 const p={periods:{allTime:{relapseCount:9},currentMonth:{relapseCount:2}}};
 assert.equal(statisticPeriod(p,'currentMonth').relapseCount,2);
 assert.equal(statisticPeriod(p,'allTime').relapseCount,9);
});
test('сводка импорта показывает технические числа без исполнения',()=>{
 const text=importSummary({newRecords:3,duplicates:2,conflicts:1,pending:4});
 assert.match(text,/3/);assert.match(text,/2/);assert.match(text,/1/);assert.match(text,/4/);
});
