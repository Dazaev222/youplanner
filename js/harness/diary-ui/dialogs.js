import {el,button,field,dialog,action,unwrap} from './dom.js';
export function normalizeDuration(value) {
  const v=value.trim()==='0'?'00:00':value.trim();
  if(!/^\d+:\d{2}$/.test(v)||Number(v.split(':')[1])>=60)return null;
  const [h,m]=v.split(':');
  return `${h.padStart(2,'0')}:${m}`;
}
export function validRelapse({triggerId,reason}={}) {return Boolean(triggerId || reason?.trim());}
export function quickTriggers(triggers) {
  const list=Object.values(triggers||{}).sort((a,b)=>a.createdAtMs-b.createdAtMs||a.triggerId.localeCompare(b.triggerId));
  return Array.from({length:3},(_,i)=>list[i]);
}
export function showInitialization(ctx) {
  const d=dialog('Дневник привычек','Укажите, сколько времени уже длится воздержание',true);
  const duration=field('Время воздержания, часы:минуты','','text');duration.input.placeholder='02:30';duration.input.inputMode='text'; duration.input.setAttribute('aria-describedby',d.error.id);
  const submit=button('Начать',()=>{} ,true);submit.type='submit';
  d.form.append(duration.wrap,d.error,submit);
  d.form.addEventListener('submit',e=>{e.preventDefault(); action(submit,d.error,async()=>{
    const value=normalizeDuration(duration.input.value);if(value===null)throw new Error('Введите HH:MM. Минуты — от 00 до 59');
    unwrap(await ctx.service.initializeDiary({duration:value,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone}));d.close();await ctx.refresh();
  });});duration.input.focus();return d;
}
export function showRelapse(ctx) {
  const d=dialog('Рецидив','Укажите триггер или причину');
  let selected, triggers={...ctx.projection.triggers};
  const choices=el('div',undefined,'diary-choices'); choices.setAttribute('role','group');choices.setAttribute('aria-label','Триггер');
  const extras=el('div'), add=field('Название нового триггера');add.wrap.hidden=true;
  const addButton=button('Сохранить триггер',()=>action(addButton,d.error,async()=>{
    const value=unwrap(await ctx.service.createTrigger({name:add.input.value.trim()}));selected=value.trigger.triggerId;triggers[selected]=value.trigger;add.input.value='';add.wrap.hidden=true;addButton.hidden=true;paint();
  }));addButton.hidden=true;
  function paint() {
    choices.replaceChildren();for(const trigger of quickTriggers(triggers)) {
      const b=button(trigger?.name||'Добавить триггер',()=>{
        if(!trigger){add.wrap.hidden=false;addButton.hidden=false;add.input.focus();return;}
        selected=selected===trigger.triggerId?undefined:trigger.triggerId;paint();
      });if(trigger)b.setAttribute('aria-pressed',String(selected===trigger.triggerId));choices.append(b);
    }
    extras.replaceChildren(); if(Object.keys(triggers).length>3) {
      const other=el('select');other.setAttribute('aria-label','Другой триггер');other.append(new Option('Другой триггер',''));
      for(const t of Object.values(triggers))other.append(new Option(t.name,t.triggerId));other.value=selected||'';
      other.addEventListener('change',()=>{selected=other.value||undefined;paint();});extras.append(other);
    }
    if(selected&&!quickTriggers(triggers).some(t=>t?.triggerId===selected))extras.append(el('p','Выбрано: '+triggers[selected].name));
  }
  paint();const reason=field('Причина','','textarea');reason.input.maxLength=4000;reason.input.setAttribute('aria-describedby',d.error.id);
  const submit=button('Подтвердить рецидив',()=>{},true);submit.type='submit';
  d.form.append(choices,extras,add.wrap,addButton,reason.wrap,d.error,button('Отмена',()=>{if(!submit.disabled)d.close();}),submit);
  d.form.addEventListener('submit',e=>{e.preventDefault();action(submit,d.error,async()=>{
    if(!validRelapse({triggerId:selected,reason:reason.input.value}))throw new Error('Укажите триггер или причину');
    d.node.dataset.busy='1';try {unwrap(await ctx.service.confirmRelapse({...(selected?{triggerId:selected}:{}),reason:reason.input.value.trim()}));d.close();await ctx.refresh();ctx.synchronize();}finally{delete d.node.dataset.busy;}
  });});return d;
}
