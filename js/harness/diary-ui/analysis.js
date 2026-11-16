import { el,button,field,action,unwrap } from './dom.js';
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
export function renderAnalysis(ctx){
 const root=el('section'),error=el('p','','diary-error'),output=el('div');error.setAttribute('role','alert');
 root.append(el('p','Вся доступная история будет передана провайдеру ИИ напрямую с устройства. Запрос может расходовать лимит провайдера. Категории не применяются автоматически.'));
 const summary=button('Общий анализ в чате',()=>{error.textContent='Интеграция с существующим чатом ещё не подключена. Запрос не отправлен.';});
 let controller;
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
 const cancel=button('Отменить запрос',()=>controller?.abort());cancel.hidden=true;
 root.append(summary,request,cancel,output,error);return root;
}
