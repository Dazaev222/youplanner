// Отложенный вызов: серия быстрых событий даёт один вызов функции — после
// паузы wait мс от последнего события. Мгновенную часть отклика (пересчёт
// итога на экране) вызывающий делает сам, сюда попадает только дорогая
// запись: хранилище, сеть.
//
// flush() — выполнить отложенный вызов прямо сейчас (уход со вкладки,
// закрытие экрана: страница может исчезнуть раньше таймера). cancel() —
// снять отложенный вызов без выполнения. Когда отложенного вызова нет,
// обе операции — тихий no-op.
export function debounce(fn, wait) {
  let timer = null;
  let lastArgs = null;

  function invoke() {
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    fn.apply(null, args);
  }

  function debounced() {
    lastArgs = arguments;
    if (timer) clearTimeout(timer);
    timer = setTimeout(invoke, wait);
  }

  debounced.flush = function () {
    if (!timer) return;
    clearTimeout(timer);
    invoke();
  };

  debounced.cancel = function () {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  return debounced;
}
