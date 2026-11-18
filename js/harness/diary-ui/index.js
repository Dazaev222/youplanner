import { createDiaryComposition } from '../diary/composition.js';
import { el, button, message, unwrap } from './dom.js';
import { subscribeDiary } from './session.js';
import { showInitialization, showRelapse } from './dialogs.js';
import { renderHistory, renderEvent, eventRow } from './history.js';
import { buildDiaryViewModel, durationParts, formatDiaryDuration } from './view-model.js';
import { calculateRingProgress } from './milestones.js';
import { renderSettings } from './settings.js';

export function mountDiary({ onBack, version = '', initialScreen = 'home', compositionFactory = createDiaryComposition, onSubmitDiaryAnalysis } = {}) {
  const root = document.getElementById('diary-view');
  let dead = false, subscription, composition, timer, initializing = false, syncing = false;
  let screen = initialScreen, eventId, stack = [], clockNodes = [], record, ring, monthLabel;
  const status = el('p', '', 'diary-status'); status.setAttribute('role', 'status');
  const header = el('header', undefined, 'diary-head');
  const title = el('h1', 'Дневник привычек');
  const content = el('div', undefined, 'diary-content');
  const ctx = { projection: null, service: null, dirty: false, refresh, synchronize, version, onBack: () => { if(canLeave()) onBack?.(); },
    // Общий анализ Дневника в чате: вызывает ассистентский ход с датасетом,
    // собранным из контекста (js/ui/assistant-diary-context.js). Без провайдера
    // — честный неготовый ответ, а не молчаливый нет-операция
    onSubmitDiaryAnalysis: typeof onSubmitDiaryAnalysis === 'function'
      ? onSubmitDiaryAnalysis
      : function () { return Promise.resolve({ ok: false, error: { code: 'DIARY_NOT_READY', message: 'Анализ в чате не подключён' } }); },
    open(next, id) { if (!canLeave()) return; stack.push([screen, eventId]); screen = next; eventId = id; paint(); },
    replace(next, id) { ctx.dirty = false; screen = next; eventId = id; paint(); }
  };
  function canLeave() { if (document.querySelector('.diary-editor .diary-primary:disabled')) return false; if (ctx.dirty && !confirm('Отбросить несохранённые изменения?')) return false; ctx.dirty = false; return true; }
  function back() {
    if (!canLeave()) return;
    if (!stack.length) { onBack?.(); return; }
    [screen, eventId] = stack.pop(); paint();
  }
  header.append(button('← Назад', back), title, button('Настройки', () => ctx.open('settings')));
  root.replaceChildren(header, content, status, button('Повторить синхронизацию', synchronize));
  content.append(el('p', 'Загружаем дневник…'));
  function tick() {
    if (dead || !ctx.projection?.initialization || screen !== 'home') return;
    const now = composition.clock.now(), vm = buildDiaryViewModel(ctx.projection, now);
    durationParts(vm.currentMs).forEach((v, i) => { if (clockNodes[i]) clockNodes[i].textContent = v; });
    if (record) record.textContent = formatDiaryDuration(vm.bestMs);
    const progress = calculateRingProgress(vm.startMs, now, ctx.projection.initialization.timeZone);
    if (ring) ring.style.strokeDashoffset = String(553 * (1 - progress.progress));
    if (monthLabel) monthLabel.textContent = `${progress.months + 1}-й месяц`;
  }
  async function refresh(repaint = true) {
    const projection = await ctx.service.getProjection();
    if (dead) return;
    ctx.projection = projection;
    if (repaint && !ctx.dirty) paint();
  }
  async function synchronize() {
    if (dead || syncing || !ctx.service) return;
    syncing = true; status.textContent = 'Синхронизация…';
    try { const result = await ctx.service.synchronize(); if (!dead) status.textContent = result.ok ? (result.value.blocked ? 'Есть заблокированные записи · проверьте данные' : result.value.unknown ? 'Результат отправки уточняется' : result.value.pending ? `Ожидает отправки: ${result.value.pending}` : 'Данные синхронизированы') : message(result.error); }
    catch (e) { if (!dead) status.textContent = message(e); }
    finally { syncing = false; }
  }
  function home() {
    const hero = el('section', undefined, 'diary-hero');
    const graphic = el('div', undefined, 'diary-ring');
    // Статичное дерево, не анимация роста.
    graphic.innerHTML = '<svg viewBox="0 0 200 200" aria-hidden="true"><circle class="diary-track" cx="100" cy="100" r="88"/><circle class="diary-progress" cx="100" cy="100" r="88"/><image href="js/harness/diary-ui/tree-reference.png" x="41" y="50" width="114" height="108" preserveAspectRatio="xMidYMid meet"/></svg>';
    ring = graphic.querySelector('.diary-progress'); monthLabel = el('p', '', 'diary-muted');
    const clock = el('div', undefined, 'diary-clock'); clock.setAttribute('aria-label', 'Время воздержания'); clockNodes = [];
    ['Дни', 'Часы', 'Мин', 'Сек'].forEach((label, i) => {
      if (i) clock.append(el('span', ':', 'diary-colon'));
      const group = el('div'), value = el('strong', '0'); clockNodes.push(value); group.append(value, el('span', label)); clock.append(group);
    });
    const metrics = el('div', undefined, 'diary-metrics'); record = el('strong');
    const attempt = el('div'); attempt.append(el('span', 'Попытка'), el('strong', String(buildDiaryViewModel(ctx.projection).attempt)));
    const best = el('div'); best.append(el('span', 'Рекорд'), record); metrics.append(attempt, best);
    hero.append(graphic, monthLabel, clock, button('Рецидив', () => showRelapse(ctx), true), metrics); content.append(hero, el('h2', 'Последние записи'));
    const recent = buildDiaryViewModel(ctx.projection).recent;
    if (!recent.length) content.append(el('p', 'Рецидивов пока нет', 'diary-muted'));
    recent.forEach(e => content.append(eventRow(ctx, e)));
    content.append(button('Вся история', () => ctx.open('history'))); tick();
  }
  function paint() {
    if (dead || !ctx.projection) return;
    title.textContent = {home:'Дневник привычек', history:'История', event:'Запись', settings:'Настройки',statistics:'Статистика',triggers:'Триггеры и категории',analysis:'Анализ ИИ',export:'Экспорт JSON',import:'Импорт JSON'}[screen] || 'Дневник привычек';
    content.replaceChildren(); clockNodes = []; ring = record = monthLabel = null;
    if (!ctx.projection.initialization) {
      content.append(el('p', 'Для первого запуска требуется интернет', 'diary-muted'));
      if (!initializing) { initializing = true; const d = showInitialization(ctx); d.node.addEventListener('close', () => { initializing = false; }, {once:true}); }
      return;
    }
    if (screen === 'home') home();
    else if (screen === 'history') content.append(renderHistory(ctx));
    else if (screen === 'event') content.append(renderEvent(ctx, eventId));
    else {
      content.append(renderSettings(ctx, screen));
    }
    if (ctx.projection.timeAnomaly) status.textContent = 'В истории есть время из будущего. Проверьте часы устройства';
  }
  async function start() {
    try {
      composition = unwrap(await compositionFactory());
      if (dead) { composition.store.close?.(); return; }
      ctx.service = composition.service;
      // Сначала загрузка с сервера, чтобы не показать ввод поверх существующей initialization.
      ctx.projection = await ctx.service.getProjection();
      if (!ctx.projection.initialization) await ctx.service.synchronize();
      subscription = await subscribeDiary(composition, payload => {
        if (dead) return;
        ctx.projection = payload.projection;
        // Обновление сервиса не уничтожает открытый редактор и его черновик.
        if (screen === 'home' || screen === 'history' || screen === 'statistics') {
          if (!ctx.dirty && !document.querySelector('.diary-dialog')) paint();
        }
      });
      if (dead) { subscription.unsubscribe(); return; }
      paint(); timer = setInterval(tick, 1000); synchronize();
    } catch (e) {
      if (dead) return; content.replaceChildren(el('p', message(e), 'diary-error'), button('Повторить', start));
    }
  }
  const onVisible = () => { if (document.visibilityState === 'visible') { tick(); synchronize(); } };
  document.addEventListener('visibilitychange', onVisible); window.addEventListener('online', synchronize);
  start();
  return { unmount() { dead = true; clearInterval(timer); subscription?.unsubscribe(); composition?.store.close?.(); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('online', synchronize); document.querySelectorAll('.diary-dialog').forEach(d => d.remove()); root.replaceChildren(); } };
}
