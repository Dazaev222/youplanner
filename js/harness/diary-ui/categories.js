import { el, button, field, action, unwrap } from './dom.js';
export function renderCategories(ctx) {
  const root=el('section'),error=el('p','','diary-error');error.setAttribute('role','alert');
  const categories=structuredClone(ctx.projection.policy?.categories||{}), mappings={...(ctx.projection.policy?.triggerMappings||{})};
  const list=el('div'), consent=field('Я согласен применить категории ко всей истории','','checkbox');
  function paint(){
    list.replaceChildren();
    for(const [id,c] of Object.entries(categories)){
      const name=field('Название категории',c.name);name.input.maxLength=200;
      name.input.addEventListener('input',()=>{c.name=name.input.value;ctx.dirty=true;});
      const target=el('select');target.setAttribute('aria-label','Объединить '+c.name+' с категорией');target.append(new Option('Выберите категорию',''));
      for(const [other,v] of Object.entries(categories))if(other!==id)target.append(new Option(v.name,other));
      const merge=button('Объединить',()=>{if(!target.value)return;for(const key of Object.keys(mappings))if(mappings[key]===id)mappings[key]=target.value;delete categories[id];ctx.dirty=true;paint();});
      list.append(name.wrap,target,merge);
    }
    for(const t of Object.values(ctx.projection.triggers)){
      const label=el('label',undefined,'diary-field');label.append(el('span',t.name));const select=el('select');select.append(new Option('Без категории',''));
      for(const [id,c] of Object.entries(categories))select.append(new Option(c.name,id));select.value=mappings[t.triggerId]||'';
      select.addEventListener('change',()=>{if(select.value)mappings[t.triggerId]=select.value;else delete mappings[t.triggerId];ctx.dirty=true;});label.append(select);list.append(label);
    }
  }
  const name=field('Новая категория');name.input.maxLength=200;
  const add=button('Создать категорию',()=>{if(!name.input.value.trim()){error.textContent='Укажите название категории';return;}categories['cat_'+crypto.randomUUID()]={name:name.input.value.trim()};name.input.value='';ctx.dirty=true;paint();});
  let pendingProposal;
  const save=button('Пересчитать',()=>action(save,error,async()=>{
    if(!consent.input.checked)throw new Error('Подтвердите применение категорий');
    const prepared=pendingProposal || unwrap(await ctx.service.prepareMutation({entityKey:'categoryPolicy',type:'applyCategoryPolicy',changes:{categories,triggerMappings:mappings}}));
    const result=await ctx.service.commitMutation(prepared,true);
    if(!result.ok){
      if(result.error.code==='UNKNOWN_COMMIT'){pendingProposal=prepared;root.querySelectorAll('input,select,button').forEach(n=>{if(n!==save)n.disabled=true;});save.textContent='Проверить сохранение';}
      else {pendingProposal=null;root.querySelectorAll('input,select,button').forEach(n=>n.disabled=false);consent.input.checked=false;save.textContent='Пересчитать';}
      throw result.error;
    }
    ctx.dirty=false;await ctx.refresh();
  }),true);
  paint();root.append(el('p','Чтобы разделить категорию, создайте новую и перенесите в неё нужные триггеры. Изменения применяются только по кнопке «Пересчитать».','diary-muted'),list,name.wrap,add,consent.wrap,error,save);return root;
}
