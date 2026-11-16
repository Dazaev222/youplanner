// Только представление календарных достижений; журнал не изменяется.
function zonedParts(ms, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(ms).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
}
export function calendarBoundary(startMs, months, timeZone) {
  const p = zonedParts(startMs,timeZone);
  const target = new Date(Date.UTC(p.year,p.month-1+months,1));
  const year=target.getUTCFullYear(), month=target.getUTCMonth();
  const day=Math.min(p.day,new Date(Date.UTC(year,month+1,0)).getUTCDate());
  const wall=Date.UTC(year,month,day,p.hour,p.minute,p.second,startMs%1000);
  let value=wall;
  for(let i=0;i<5;i++) {
    const q=zonedParts(value,timeZone);
    const correction=wall-Date.UTC(q.year,q.month-1,q.day,q.hour,q.minute,q.second,startMs%1000);
    if(!correction) break;
    value+=correction;
  }
  return value;
}
export function calculateRingProgress(startMs,endMs,timeZone) {
  let months=0;
  while(calendarBoundary(startMs,months+1,timeZone)<=endMs) months++;
  const from=calendarBoundary(startMs,months,timeZone), to=calendarBoundary(startMs,months+1,timeZone);
  return {months, progress:Math.max(0,Math.min(1,(endMs-from)/(to-from)))};
}
export function collectMilestones(intervals,timeZone) {
  return (intervals || []).map(i=>({...i,...calculateRingProgress(i.startMs,i.endMs,timeZone)})).filter(i=>i.months>0);
}
