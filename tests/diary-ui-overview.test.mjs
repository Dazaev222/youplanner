import test from 'node:test';
import assert from 'node:assert/strict';
import { overviewText } from '../js/harness/diary-ui/overview.js';
test('общая статистика отличает недоступность и данные дневника',()=>{
 assert.match(overviewText(null),/недоступ/);
 assert.match(overviewText({initialization:{},currentMs:60000,bestMs:120000,relapseCount:3}),/Рецидивов: 3/);
});
