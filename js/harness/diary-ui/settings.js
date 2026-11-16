import { el, button, field, action, unwrap } from './dom.js';
import { triggerName, formatDiaryDuration } from './view-model.js';
import { calculateRingProgress } from './milestones.js';
import { renderCategories } from './categories.js';
import { renderAnalysis } from './analysis.js';
export const settingsLinks = [['history','История'],['statistics','Статистика'],['triggers','Управление триггерами и категориями'],['analysis','Анализ ИИ'],['export','Экспорт JSON'],['import','Импорт JSON']];
export function statisticPeriod(p, period) { return p.periods[period]; }
export function periodStreaks(projection, period) {
  const p = statisticPeriod(projection, period);
  return { currentMs: p.currentMs ?? projection.currentMs ?? 0, bestMs: p.bestMs ?? projection.bestMs ?? 0 };
}
export function importSummary(p) {
  return `Новых: ${p.added ?? p.newRecords ?? 0}. Дублей: ${p.skippedDuplicates ?? p.duplicates ?? 0}. Конфликтов: ${Array.isArray(p.conflicts) ? p.conflicts.length : p.conflicts ?? 0}. Ожидают: ${p.pending ?? 0}. Заблокированных зависимостей: ${p.blockedDependencies?.length ?? 0}. Требуют отдельного согласия: ${p.requiresSeparateConsent?.length ?? 0}.`;
}
export function renderSettings(ctx, screen) {
  const root = el('div', undefined, 'diary-settings');
  const error = el('p', '', 'diary-error'); error.setAttribute('role','alert');
  if (screen === 'settings') {
    root.append(el('h2','Приложение'));
    for (const [key,label] of settingsLinks) root.append(button(label,()=>ctx.open(key)));
    root.append(el('h2','О приложении'),el('p','Версия: '+ctx.version),button('Выход в YouPlanner',ctx.onBack));
  } else if (screen === 'triggers') {
    root.append(el('p','Переименование меняет отображение во всей истории. Удаление не предусмотрено.','diary-muted'));
    for (const t of Object.values(ctx.projection.triggers)) {
      const wrap=el('section'), name=field('Название триггера',t.name); name.input.maxLength=200;
      const consent=field('Я согласен на изменение истории','','checkbox');let pendingProposal;
      const save=button('Сохранить',()=>action(save,error,async()=>{
        if(!consent.input.checked)throw new Error('Подтвердите согласие');
        const prepared=pendingProposal || unwrap(await ctx.service.prepareMutation({entityKey:`trigger_${t.triggerId}`,changes:{name:name.input.value.trim()}}));
        const result=await ctx.service.commitMutation(prepared,true);
        if(!result.ok){if(result.error.code==='UNKNOWN_COMMIT'){pendingProposal=prepared;name.input.disabled=true;save.textContent='Проверить сохранение';}else{pendingProposal=null;name.input.disabled=false;consent.input.checked=false;save.textContent='Сохранить';}throw result.error;}
        ctx.dirty=false;await ctx.refresh();
      }));
      name.input.addEventListener('input',()=>{ctx.dirty=true;});
      wrap.append(name.wrap,consent.wrap,save);root.append(wrap);
    }
    const name=field('Новый триггер');name.input.maxLength=200;
    const add=button('Добавить триггер',()=>action(add,error,async()=>{unwrap(await ctx.service.createTrigger({name:name.input.value.trim()}));await ctx.refresh();ctx.synchronize();}));
    root.append(name.wrap,add,el('h2','Категории'));
    root.append(renderCategories(ctx));
  } else if (screen === 'statistics') {
    const periods=el('div'), data=el('div');
    for(const [key,label] of [['allTime','Всё время'],['currentMonth','Текущий месяц']])periods.append(button(label,()=>draw(key)));
    root.append(periods,data);
    function draw(period){
      const p=statisticPeriod(ctx.projection,period);data.replaceChildren();
      const streaks=periodStreaks(ctx.projection,period);
      data.append(el('h2',period==='allTime'?'Всё время':'Текущий месяц'),el('p',`Рецидивов: ${p.relapseCount}`),el('p','Текущая серия: '+formatDiaryDuration(streaks.currentMs)),el('p','Рекорд: '+formatDiaryDuration(streaks.bestMs)));
      const segments=period==='allTime'?ctx.projection.segmentsByMonth:p.segments;
      data.append(el('h2','Серии по месяцам'));
      for(const s of segments||[]){
        const row=el('div',undefined,'diary-chart-row');const meter=el('meter');meter.min=0;meter.max=Math.max(...(segments||[]).map(x=>x.totalMs),1);meter.value=s.totalMs;meter.setAttribute('aria-label','Время серий за '+s.month);
        row.append(el('strong',s.month),meter,el('p',`Серии: ${formatDiaryDuration(s.totalMs)} · Рецидивов: ${s.eventCount}`),el('p',`Лучшая полная серия: ${formatDiaryDuration(s.bestFullMs)} · Часть в месяце: ${formatDiaryDuration(s.bestPortionMs)}`));data.append(row);
      }
      for(const [key,title] of [['triggerFrequencies','Частые триггеры'],['reasonFrequencies','Причины'],['categoryFrequencies','Категории']]){
        data.append(el('h2',title));if(!p[key]?.length)data.append(el('p','Рецидивов пока нет','diary-muted'));
        for(const f of p[key]||[])data.append(el('p',`${key==='triggerFrequencies'?triggerName(ctx.projection,f.value):key==='categoryFrequencies'?(ctx.projection.policy?.categories?.[f.value]?.name||f.value):f.value} — ${f.count}`));
      }
      data.append(el('h2','Месячные достижения'));
      let earned=0;
      for(const interval of ctx.projection.intervals||[]){const m=calculateRingProgress(interval.startMs,interval.endMs,ctx.projection.initialization.timeZone).months;if(m){earned+=m;data.append(el('p',`${m} мес. · ${formatDiaryDuration(interval.durationMs)}`));}}
      if(!earned)data.append(el('p','Полных календарных месяцев пока нет','diary-muted'));
    }draw('allTime');
  } else if(screen==='export'){
    root.append(el('p','Экспорт включает локальные записи, ожидающие отправки. Работает без сети.'));
    const save=button('Скачать JSON',()=>action(save,error,async()=>{
      const value=unwrap(await ctx.service.exportBackup());
      error.textContent=`Записей: ${Object.keys(value.data.events).length}. Неотправленные данные: ${Object.values(value.recordStates).some(s=>s!=='acknowledged')?'есть':'нет'}. Файл не включает ещё не полученные записи других устройств.`;
      const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='youplanner-diary-'+new Date().toISOString().slice(0,16).replaceAll(':','').replace('T','-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
    }),true);root.append(save);
  } else if(screen==='import'){
    root.append(el('p','Импорт только добавляет отсутствующие данные. Существующие записи не откатываются.'));
    const file=field('Файл дневника JSON','','file');file.input.accept='.json,application/json';
    const summary=el('p'), consent=field('Я подтверждаю добавляющий импорт','','checkbox');let plan,session;
    const execute=button('Добавить записи',()=>action(execute,error,async()=>{
      if(!consent.input.checked)throw new Error('Подтвердите импорт');
      if(!plan)throw new Error('Сначала проверьте файл');
      session=plan.sessionId;const report=unwrap(await ctx.service.importBackup({plan,onEntry:entry=>{summary.textContent='Обработка: '+entry.entryId;}}));summary.textContent=importSummary(report);await ctx.refresh(false);resume.hidden=!report.pending;
    }),true);execute.hidden=true;
    const resume=button('Возобновить импорт',()=>action(resume,error,async()=>{const report=unwrap(await ctx.service.resumeBackupImport({sessionId:session}));summary.textContent=importSummary(report);resume.hidden=!report.pending;await ctx.refresh(false);}));resume.hidden=true;
    const preview=button('Проверить файл',()=>action(preview,error,async()=>{
      const selected=file.input.files[0];if(!selected)throw new Error('Выберите файл');if(selected.size>10*1024*1024)throw new Error('Файл больше 10 MiB');
      const parsed=unwrap(await ctx.service.validateBackup(await selected.text()));plan=unwrap(await ctx.service.planBackupImport(parsed));summary.textContent=importSummary(plan);execute.hidden=false;consent.input.checked=false;
    }));
    file.input.addEventListener('change',()=>{plan=null;execute.hidden=true;summary.textContent='';});root.append(file.wrap,preview,summary,consent.wrap,execute,resume);
  } else if(screen==='analysis'){
    root.append(renderAnalysis(ctx));
  }
  root.append(error);return root;
}
