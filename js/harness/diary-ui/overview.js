import { createDiaryComposition } from '../diary/composition.js';
import { formatDiaryDuration } from './view-model.js';
export function overviewText(p){
 if(!p?.initialization)return 'Данные дневника недоступны';
 return `Текущая серия: ${formatDiaryDuration(p.currentMs)} · Рекорд: ${formatDiaryDuration(p.bestMs)} · Рецидивов: ${p.relapseCount}`;
}
export async function loadDiaryOverview(node){
 node.textContent='Загрузка дневника…';let composition;
 try{
  const result=await createDiaryComposition();if(!result.ok)throw result.error;composition=result.value;
  const p=await composition.service.getProjection();
  node.textContent=overviewText(p)+' · Данные на этом устройстве; отправка проверяется в дневнике';
 }catch{node.textContent=overviewText(null);}finally{composition?.store.close?.();}
}
