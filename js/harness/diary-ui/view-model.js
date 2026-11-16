export function durationParts(ms) {
  const s = Math.floor(Math.max(0, ms || 0) / 1000);
  return [String(Math.floor(s / 86400)), ...[Math.floor(s / 3600) % 24, Math.floor(s / 60) % 60, s % 60].map(v => String(v).padStart(2, '0'))];
}
export function formatDiaryDuration(ms, seconds = false) { return durationParts(ms).slice(0, seconds ? 4 : 3).join(':'); }
export function selectRecentEvents(events = [], limit = 4) {
  return [...events].sort((a,b) => b.occurredAtMs - a.occurredAtMs || b.eventId.localeCompare(a.eventId)).slice(0,limit);
}
export function triggerName(projection, id) { return projection.triggers?.[id]?.name || 'Без триггера'; }
export function diaryDate(ms, timeZone, seconds = false) {
  const parts = new Intl.DateTimeFormat('ru-RU', {timeZone, day:'numeric', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit', ...(seconds ? {second:'2-digit'} : {})}).formatToParts(ms);
  const get = type => parts.find(p => p.type === type)?.value || '';
  const time = [get('hour'), get('minute'), ...(seconds ? [get('second')] : [])].join(':');
  return `${get('day')} ${get('month')} ${get('year')}, ${time}`;
}
export function buildDiaryViewModel(projection, nowMs = Date.now()) {
  const startMs = projection.intervals?.at(-1)?.startMs ?? projection.initialization?.startedAtMs ?? nowMs;
  const currentMs = Math.max(0, nowMs - startMs);
  return {currentMs, startMs, bestMs: Math.max(projection.bestMs || 0,currentMs), attempt: 1 + new Set((projection.events || []).map(e=>e.eventId)).size, recent:selectRecentEvents(projection.events)};
}
