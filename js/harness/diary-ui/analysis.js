import { el,button,field,action,unwrap } from './dom.js';
import { buildAnalysisDataset } from '../diary/analysis.js';
import { triggerName } from './view-model.js';
export function analysisFailure(error, openKeySettings) {
  if (error?.code !== 'PROVIDER_KEY_MISSING') return null;
  openKeySettings();
  return 'Ключ ИИ не настроен. Введите ключ в открывшихся настройках и повторите запрос';
}
function openKeySettings() {
  // Ключ дневника — тот же youplanner.api_key, который вводит модалка настроек ассистента.
  import('../../ui/assistant-view.js').then(m => m.openAssistantKeyModal('api')).catch(() => {});
}
// Модель берём из настроек ассистента: показываем её в сводке согласия и
// проверяем свежесть на подтверждении. Без доступа к модулю (старый клиент,
// не-браузерное окружение) — пустая строка, проверка модели просто пропускается.
async function assistantChatModel() {
  try {
    const m = await import('../../ui/assistant-view.js');
    return typeof m.readAssistantModel === 'function' ? String(m.readAssistantModel() || '') : '';
  } catch (e) { return ''; }
}
function isoDay(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : '?';
}
export function renderAnalysis(ctx){
 const root=el('section'),error=el('p','','diary-error'),output=el('div');error.setAttribute('role','alert');
 root.append(el('p','Вся доступная история будет передана провайдеру ИИ напрямую с устройства. Запрос может расходовать лимит провайдера. Категории не применяются автоматически.'));
 // Общий анализ в чате (мастер-ТЗ §5.2): датасет собирается ЛОКАЛЬНО
 // (getSnapshot + buildAnalysisDataset), сеть провайдера молчит до явного
 // одноразового согласия. Отмена ничего не отправляет; после ошибки или
 // изменения снимка/модели согласие инвалидируется — повтор требует
 // нового подтверждения.
 const summary=button('Общий анализ в чате',()=>action(summary,error,async()=>{
    if(!navigator.onLine)throw new Error('Для анализа требуется интернет. Отложенный запрос не создаётся');
    ctx.dirty=true;
    const snapshot=await ctx.service.getSnapshot();
    const datasetResult=await buildAnalysisDataset({snapshot});
    if(!datasetResult.ok)throw datasetResult.error;
    const dataset=datasetResult.value;
    const model=await assistantChatModel();
    const first=dataset.events.length?dataset.events[0].occurredAtMs:null;
    const last=dataset.events.length?dataset.events[dataset.events.length-1].occurredAtMs:null;
    output.replaceChildren();
    output.append(
      el('p','Провайдер: сервис нейросети ассистента'+(model?' (модель '+model+')':'')+'. Запрос уйдёт напрямую с устройства.','diary-muted'),
      el('p','Событий: '+dataset.events.length+' (с '+isoDay(first)+' по '+isoDay(last)+'). Включаются причины событий и названия триггеров.','diary-muted'),
      el('p',dataset.completeness.status==='complete'
        ?'Покрытие истории: complete. Все записи синхронизированы.'
        :'Покрытие истории: '+dataset.completeness.status+'. Часть записей ещё не синхронизирована — анализ покроет сохранённые события.','diary-muted'),
      el('p','Результат придёт в основной чат ассистента и может сохраниться в его локальной истории. Ответ тоже может содержать чувствительные сведения.','diary-muted'),
    );
    const consent=field('Я согласен отправить историю дневника в анализ','','checkbox');
    let inflight=null;
    const cancel=button('Отмена',()=>{ if(inflight)inflight.abort(); output.replaceChildren(); ctx.dirty=false; });
    const confirm=button('Передать и проанализировать',()=>action(confirm,error,async()=>{
      if(!consent.input.checked)throw new Error('Подтвердите отправку истории в анализ Дневника.');
      if(!navigator.onLine)throw new Error('Для анализа требуется интернет. Отложенный запрос не создаётся');
      const fingerprint=await ctx.service.getFingerprint();
      if(fingerprint!==dataset.sourceFingerprint){
        consent.input.checked=false;
        throw new Error('История изменилась. Нажмите «Общий анализ в чате» ещё раз — сводка обновится');
      }
      const freshModel=await assistantChatModel();
      if(model&&freshModel&&freshModel!==model){
        consent.input.checked=false;
        throw new Error('Модель изменилась. Нажмите «Общий анализ в чате» ещё раз — сводка обновится');
      }
      inflight=new AbortController();
      let result;
      try{ result=await ctx.onSubmitDiaryAnalysis({dataset:dataset,signal:inflight.signal}); }
      finally{ inflight=null; }
      if(result&&result.ok===false){
        consent.input.checked=false;
        const text=analysisFailure(result.error,openKeySettings);
        throw new Error(text!==null?text:((result.error&&result.error.message)||'Анализ не запущен'));
      }
      consent.input.checked=false;
      ctx.dirty=false;
      output.replaceChildren(el('p','Анализ отправлен ассистенту. Ответ придёт в ленту чата.','diary-muted'));
    }),true);
    output.append(consent.wrap,cancel,confirm);
 }),true);
 const request=button('Подготовить категории',()=>action(request,error,async()=>{
   if(!navigator.onLine)throw new Error('Для анализа требуется интернет. Отложенный запрос не создаётся');
   controller=new AbortController();cancel.hidden=false;ctx.dirty=true;
   try{
    const result=unwrap(await ctx.service.requestAnalysis({signal:controller.signal}));
    const draft=result.draft;output.replaceChildren();
    output.append(el('p','Покрытие истории: '+(typeof draft.completeness==='string'?draft.completeness:JSON.stringify(draft.completeness)),'diary-muted'));
    const categories=Object.fromEntries(draft.proposal.categories.map(c=>[c.id,{name:c.name}]));
    const mappings=Object.fromEntries(draft.proposal.triggerMappings.map(m=>[m.triggerId,m.categoryId]));
    // Редактируется полный набор, подготовленный сервисом, а не свободный текст модели.
    const prepared=unwrap(await ctx.service.prepareCategoryPolicy({draftId:draft.analysisId}));
    Object.assign(categories,prepared.changes.categories);Object.assign(mappings,prepared.changes.triggerMappings);
    for(const [id,cat] of Object.entries(categories)){
      const name=field('Категория',cat.name);name.input.maxLength=200;
      name.input.addEventListener('input',()=>{cat.name=name.input.value;});output.append(name.wrap);
    }
    for(const t of Object.values(ctx.projection.triggers)){
      const label=el('label',undefined,'diary-field');label.append(el('span',triggerName(ctx.projection,t.triggerId)));const select=el('select');select.append(new Option('Без категории',''));
      for(const [id,c] of Object.entries(categories))select.append(new Option(c.name,id));select.value=mappings[t.triggerId]||'';
      select.addEventListener('change',()=>{if(select.value)mappings[t.triggerId]=select.value;else delete mappings[t.triggerId];});label.append(select);output.append(label);
    }
    const consent=field('Я согласен применить предложенные категории','','checkbox');
    const apply=button('Применить',()=>action(apply,error,async()=>{
      if(!consent.input.checked)throw new Error('Подтвердите применение категорий');
      const proposal=unwrap(await ctx.service.prepareCategoryPolicy({draftId:draft.analysisId,categories,triggerMappings:mappings}));
      const applied=await ctx.service.applyAnalysis({draftId:draft.analysisId,proposal:proposal.proposal,consent:true});
      if(!applied.ok){consent.input.checked=false;throw applied.error;}
      ctx.dirty=false;await ctx.refresh();
    }),true);output.append(consent.wrap,apply);
   }catch(e){
    const text=analysisFailure(e,openKeySettings);
    if(text===null)throw e;
    error.textContent=text;
   }finally{cancel.hidden=true;controller=null;}
 }),true);
 let controller;
 const cancel=button('Отменить запрос',()=>controller?.abort());cancel.hidden=true;
 root.append(summary,request,cancel,output,error);return root;
}
