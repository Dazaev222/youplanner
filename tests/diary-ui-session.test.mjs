import test from 'node:test';
import assert from 'node:assert/strict';
import { subscribeDiary } from '../js/harness/diary-ui/session.js';
test('подписка использует value.service, передаёт изменения и отписывается', async () => {
  let off=0, seen=0;
  const composition={service:{async subscribe({onChange}) {await onChange({projection:{events:[]}});return {ok:true,value:{unsubscribe(){off++;}}};}}};
  const subscription=await subscribeDiary(composition,p=>{assert.ok(p.projection);seen++;});
  subscription.unsubscribe();assert.equal(seen,1);assert.equal(off,1);
});
