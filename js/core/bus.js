/* YouPlanner — шина событий.
   Единственный канал связи между слоями «синхронизация», «данные» и
   «интерфейс»: слой не зовёт чужие функции напрямую, а эмитит событие,
   а кто на него подписан — решает проводка в конце инлайн-скрипта.
   Так дерево зависимостей остаётся однонаправленным (core ← data ←
   sync/ui), и разбиение на ES-модули не создаёт циклических импортов.

   События:
     data:changed  — правка локальных данных; подписчик — scheduleSync
     sync:applied  — применён снимок с сервера; подписчики — рендеры
     storage:error — localStorage не смог записать (квота); подписчик — тост

   Шина синхронная: emit выполняет подписчиков сразу, в порядке подписки.
   Обратный порядок отписки (return функции-off) нужен тестам и будущим
   модулям, в приложении подписки живут всё время работы страницы. */

export const bus = (() => {
  const listeners = new Map();

  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, []);
    listeners.get(event).push(handler);
    return function () { off(event, handler); };
  }

  function off(event, handler) {
    const list = listeners.get(event);
    if (!list) return;
    const index = list.indexOf(handler);
    if (index !== -1) list.splice(index, 1);
  }

  function emit(event, payload) {
    const list = listeners.get(event);
    if (!list) return;
    // копия: подписчик имеет право отписаться прямо из обработчика
    list.slice().forEach(function (handler) { handler(payload); });
  }

  return { on: on, off: off, emit: emit };
})();
