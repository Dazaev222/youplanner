import {test} from 'node:test';
import assert from 'node:assert/strict';
const d=await import('../js/harness/diary-ui/dialogs.js').catch(()=>({}));
test('черновики: часы >23, ноль, пробелы, причина без триггера',()=>{
 assert.equal(typeof d.normalizeDuration,'function');
 assert.equal(d.normalizeDuration('0'),'00:00');
 assert.equal(d.normalizeDuration('125:59'),'125:59');
 assert.equal(d.normalizeDuration('12:60'),null);
 assert.equal(d.validRelapse({reason:'   '}),false);
 assert.equal(d.validRelapse({reason:'Причина'}),true);
 assert.equal(d.validRelapse({triggerId:'t'}),true);
});
test('время нормализуется к HH:MM: 2:30 → 02:30, часы >23 сохраняются',()=>{
 assert.equal(d.normalizeDuration('2:30'),'02:30');
 assert.equal(d.normalizeDuration(' 2:30 '),'02:30');
 assert.equal(d.normalizeDuration('0:00'),'00:00');
 assert.equal(d.normalizeDuration('125:59'),'125:59');
 assert.equal(d.normalizeDuration('2:60'),null);
 assert.equal(d.normalizeDuration('2:5'),null);
});
test('ровно три быстрые позиции в стабильном порядке',()=>{
 assert.equal(typeof d.quickTriggers,'function');
 assert.deepEqual(d.quickTriggers({}).map(x=>x?.triggerId),[undefined,undefined,undefined]);
 assert.deepEqual(d.quickTriggers({b:{triggerId:'b',createdAtMs:2},a:{triggerId:'a',createdAtMs:1},d:{triggerId:'d',createdAtMs:4},c:{triggerId:'c',createdAtMs:3}}).map(x=>x.triggerId),['a','b','c']);
});
