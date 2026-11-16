import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEventChanges, saveEventDraft, eventFormValues, reloadEventForm } from '../js/harness/diary-ui/history.js';

function localInputValue(ms) {
  const date = new Date(ms);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
}
test('eventFormValues: локальное время устройства, пустые причина и триггер допустимы', () => {
  const ms = Date.parse('2026-11-16T14:35:00Z');
  assert.deepEqual(eventFormValues({ occurredAtMs: ms, reason: 'Причина', triggerId: 't1' }), { occurredAt: localInputValue(ms), reason: 'Причина', triggerId: 't1' });
  assert.deepEqual(eventFormValues({ occurredAtMs: 0 }), { occurredAt: localInputValue(0), reason: '', triggerId: '' });
});
test('конфликт: форма перезаполняется актуальными данными из свежего снимка', async () => {
  const fresh = { eventId: 'e1', occurredAtMs: Date.parse('2026-11-16T14:35:00Z'), reason: 'Новая причина', triggerId: 't2' };
  let refreshed = 0;
  const ctx = {
    projection: { events: [{ eventId: 'e1', occurredAtMs: 1000, reason: 'Старая', triggerId: 't1' }] },
    dirty: true,
    async refresh(repaint) { refreshed++; assert.equal(repaint, false); ctx.projection = { events: [fresh] }; },
  };
  const fields = { at: { value: 'черновик' }, reason: { value: 'черновик' }, trigger: { value: 't1' } };
  const values = await reloadEventForm(ctx, 'e1', fields);
  assert.equal(refreshed, 1);
  assert.equal(fields.at.value, localInputValue(fresh.occurredAtMs));
  assert.equal(fields.reason.value, 'Новая причина');
  assert.equal(fields.trigger.value, 't2');
  assert.equal(values.triggerId, 't2');
  assert.equal(ctx.dirty, false);
});
test('конфликт: запись исчезла из снимка — поля не трогаем, черновик остаётся', async () => {
  const ctx = { projection: { events: [] }, dirty: true, async refresh() { ctx.projection = { events: [] }; } };
  const fields = { at: { value: 'a' }, reason: { value: 'b' }, trigger: { value: 'c' } };
  assert.equal(await reloadEventForm(ctx, 'e1', fields), null);
  assert.deepEqual(fields, { at: { value: 'a' }, reason: { value: 'b' }, trigger: { value: 'c' } });
  assert.equal(ctx.dirty, true);
});

test('редактор снимает триггер явным маркером и сохраняет причину', () => {
  assert.deepEqual(buildEventChanges({ occurredAtMs: 1000, triggerId: '', reason: ' Причина ' }), { occurredAtMs: 1000, removeTrigger: true, reason: 'Причина' });
  assert.throws(() => buildEventChanges({ occurredAtMs: 1000, triggerId: '', reason: ' ' }), /триггер или причину/);
});
test('сохранение требует согласия, сохраняет черновик при конфликте и не переподтверждает автоматически', async () => {
  let commits = 0, prepares = 0;
  const draft = { occurredAtMs: 1000, triggerId: '', reason: 'Причина' };
  const service = {
    async prepareMutation(input) { prepares++; assert.equal(input.entityKey, 'event_e1'); assert.equal(input.changes.removeTrigger, true); return { ok: true, value: { token: prepares } }; },
    async commitMutation(prepared, consent) { commits++; assert.equal(consent, true); return { ok: false, error: { code: 'CONFLICT_RECONFIRM', message: 'Изменилось' } }; }
  };
  await assert.rejects(() => saveEventDraft(service, 'e1', draft, false), /согласие/);
  assert.equal(prepares, 0);
  const result = await saveEventDraft(service, 'e1', draft, true);
  assert.equal(result.error.code, 'CONFLICT_RECONFIRM');
  assert.equal(commits, 1); assert.equal(prepares, 1); assert.equal(draft.reason, 'Причина');
});
