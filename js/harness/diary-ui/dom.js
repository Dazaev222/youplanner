export function el(tag, text, className) {
  const node=document.createElement(tag); if(text!==undefined) node.textContent=text; if(className) node.className=className; return node;
}
export function button(text, fn, primary=false) {
  const b=el('button',text,'diary-button'+(primary?' diary-primary':'')); b.type='button'; b.addEventListener('click',fn); return b;
}
export function field(label, value='', type='text') {
  const wrap=el('label',undefined,'diary-field'), input=el(type==='textarea'?'textarea':'input');
  if(type!=='textarea') input.type=type; input.value=value; wrap.append(el('span',label),input); return {wrap,input};
}
export function message(error) {
  const code=error?.code;
  const messages={CONFLICT_RECONFIRM:'Запись изменилась на другом устройстве. Проверьте изменения и подтвердите ещё раз',UNKNOWN_COMMIT:'Проверяем, было ли изменение сохранено. Повторная проверка использует прежнюю операцию.',ONLINE_REQUIRED:'Для этого действия требуется интернет',AUTH_REQUIRED:'Войдите в аккаунт владельца в настройках YouPlanner',STALE_ANALYSIS:'Анализ устарел. Запросите новый анализ',STORAGE_ERROR:'Не удалось сохранить данные на устройстве'};
  return messages[code] || error?.message || 'Не удалось выполнить действие. Повторите попытку';
}
export function dialog(title, description, required=false) {
  const node=el('dialog',undefined,'diary-dialog'), heading=el('h2',title), note=el('p',description,'diary-muted');
  heading.id='diary-dialog-title'; note.id='diary-dialog-note'; node.setAttribute('aria-labelledby',heading.id);node.setAttribute('aria-describedby',note.id);
  const form=el('form'), error=el('p','','diary-error');error.id='diary-dialog-error'; error.setAttribute('role','alert');form.append(heading,note); node.append(form);document.body.append(node);
  const origin=document.activeElement;
  const close=()=>{node.close();node.remove(); origin?.focus();};
  node.addEventListener('cancel',e=>{e.preventDefault();if(!required&&!node.dataset.busy)close();});
  node.showModal(); return {node,form,error,close};
}
export async function action(b, error, fn) {
  if(b.disabled)return; b.disabled=true;error.textContent='';
  try { await fn(); } catch(e) {error.textContent=message(e);} finally {b.disabled=false;}
}
export function unwrap(result) { if(!result?.ok)throw result?.error || new Error('Нет ответа сервиса');return result.value; }
