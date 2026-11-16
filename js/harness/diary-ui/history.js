import { el, button, field, action, unwrap, message } from './dom.js';
import { diaryDate, triggerName, selectRecentEvents, formatDiaryDuration } from './view-model.js';

export function buildEventChanges({ occurredAtMs, triggerId, reason }) {
  const text = reason.trim();
  if (!triggerId && !text) throw new Error('Укажите триггер или причину');
  if (!Number.isSafeInteger(occurredAtMs) || occurredAtMs < 0) throw new Error('Укажите дату и время');
  return { occurredAtMs, reason: text, ...(triggerId ? { triggerId } : { removeTrigger: true }) };
}
export async function saveEventDraft(service, eventId, draft, consent) {
  if (!consent) throw new Error('Требуется явное согласие на пересчёт');
  const prepared = unwrap(await service.prepareMutation({ entityKey: `event_${eventId}`, changes: buildEventChanges(draft) }));
  return service.commitMutation(prepared, true);
}
export function eventFormValues(event) {
  // Отдельные локальные поля: системная зона телефона может отличаться от зоны дневника.
  const date = new Date(event.occurredAtMs);
  return {
    occurredAt: new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19),
    reason: event.reason || '',
    triggerId: event.triggerId || '',
  };
}
export async function reloadEventForm(ctx, eventId, fields) {
  await ctx.refresh(false);
  const event = ctx.projection.events.find(e => e.eventId === eventId);
  if (!event) return null;
  const values = eventFormValues(event);
  fields.at.value = values.occurredAt;
  fields.reason.value = values.reason;
  fields.trigger.value = values.triggerId;
  ctx.dirty = false;
  return values;
}
export function eventRow(ctx, event, details = false) {
  const row = button('', () => ctx.open('event', event.eventId));
  row.classList.add('diary-entry');
  const time = el('time', diaryDate(event.occurredAtMs, ctx.projection.initialization?.timeZone));
  time.dateTime = new Date(event.occurredAtMs).toISOString();
  row.append(time, el('strong', triggerName(ctx.projection, event.triggerId)));
  if (details && event.reason) row.append(el('span', event.reason, 'diary-muted'));
  return row;
}
export function renderHistory(ctx) {
  const node = el('div', undefined, 'diary-list');
  const events = selectRecentEvents(ctx.projection.events, Infinity);
  if (!events.length) node.append(el('p', 'Рецидивов пока нет', 'diary-muted'));
  let count = 0;
  const more = button('Показать ещё', () => appendPage());
  function appendPage() {
    more.remove();
    for (const event of events.slice(count, count + 50)) node.append(eventRow(ctx, event, true));
    count += 50;
    if (count < events.length) node.append(more);
  }
  appendPage();
  return node;
}
export function renderEvent(ctx, eventId) {
  const event = ctx.projection.events.find(e => e.eventId === eventId);
  const root = el('div', undefined, 'diary-detail');
  if (!event) { root.append(el('p', 'Запись не найдена')); return root; }
  const interval = ctx.projection.intervals.find(i => i.toEventId === eventId);
  root.append(el('p', diaryDate(event.occurredAtMs, ctx.projection.initialization?.timeZone, true)), el('h3', triggerName(ctx.projection, event.triggerId)), el('p', event.reason || 'Причина не указана'));
  if (interval) root.append(el('p', 'Серия: ' + formatDiaryDuration(interval.durationMs)));
  const edit = button('Редактировать', () => {
    edit.hidden = true;
    const form = el('form', undefined, 'diary-editor');
    const initial = eventFormValues(event);
    const at = field('Дата и время (часовой пояс устройства)', initial.occurredAt, 'datetime-local');
    at.input.step = '1';
    const reason = field('Причина', initial.reason, 'textarea'); reason.input.maxLength = 4000;
    const label = el('label', undefined, 'diary-field'); label.append(el('span', 'Триггер'));
    const select = el('select'); select.append(new Option('Без триггера', ''));
    for (const t of Object.values(ctx.projection.triggers)) select.append(new Option(t.name, t.triggerId));
    select.value = initial.triggerId; label.append(select);
    const clearTrigger = button('Снять триггер', () => { select.value = ''; ctx.dirty = true; });
    label.append(clearTrigger);
    const consent = field('Я согласен на пересчёт истории', '', 'checkbox');
    const error = el('p', '', 'diary-error'); error.setAttribute('role', 'alert');
    const submit = button('Пересчитать', () => {}, true); submit.type = 'submit';
    let uncertain = null;
    form.addEventListener('submit', e => { e.preventDefault(); action(submit, error, async () => {
      const draft = { occurredAtMs: new Date(at.input.value).getTime(), triggerId: select.value, reason: reason.input.value };
      let result;
      if (uncertain) result = await ctx.service.commitMutation(uncertain, true);
      else {
        if (!consent.input.checked) throw new Error('Требуется явное согласие на пересчёт');
        const prepared = unwrap(await ctx.service.prepareMutation({ entityKey: `event_${eventId}`, changes: buildEventChanges(draft) }));
        result = await ctx.service.commitMutation(prepared, true);
        if (result.error?.code === 'UNKNOWN_COMMIT' || result.error?.code === 'UNKNOWN_RESULT') uncertain = prepared;
      }
      if (!result.ok) {
        if (uncertain) clearTrigger.disabled = true;
        if (result.error.code === 'CONFLICT_RECONFIRM') { uncertain = null; consent.input.checked = false; at.input.disabled = select.disabled = reason.input.disabled = clearTrigger.disabled = false; submit.textContent = 'Пересчитать'; await reloadEventForm(ctx, eventId, { at: at.input, reason: reason.input, trigger: select }); }
        if (uncertain) { at.input.disabled = true; select.disabled = true; reason.input.disabled = true; submit.textContent = 'Проверить сохранение'; }
        throw result.error;
      }
      await ctx.refresh(false); ctx.replace('event', eventId);
    }); });
    const cancel = button('Отмена', () => { if (!submit.disabled && !uncertain) { form.remove(); edit.hidden = false; ctx.dirty = false; } });
    form.addEventListener('input', () => { ctx.dirty = true; });
    form.append(at.wrap, label, reason.wrap, consent.wrap, el('p', 'Правка доступна только онлайн. Исходная запись сохраняется.', 'diary-muted'), error, submit, cancel);
    root.append(form); at.input.focus();
  });
  root.append(edit); return root;
}
