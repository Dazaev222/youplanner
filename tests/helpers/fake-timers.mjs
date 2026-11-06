// Фейковые часы для тестов жестов. Детектор долгого нажатия получает их
// через инъекцию (options.scheduleTimer/cancelTimer в
// createLongPressDetector), поэтому тест сам решает, когда «проходит время».
// Реальный setTimeout в node --test сделал бы проверку порога 450 мс медленной
// и дрожащей: машина теста не успевает за настенные часы.

export function makeFakeTimers() {
  let now = 0;
  let seq = 0;
  let tasks = [];

  return {
    now: () => now,
    // Сигнатура совпадает с setTimeout: (fn, ms) -> id
    schedule(fn, ms) {
      seq += 1;
      tasks.push({ id: seq, at: now + ms, fn });
      return seq;
    },
    // Сигнатура совпадает с clearTimeout: (id) -> void
    cancel(id) {
      tasks = tasks.filter((t) => t.id !== id);
    },
    // Продвинуть часы и исполнить все задачи, чей срок наступил, в порядке
    // очерёдности (при равном сроке — раньше поставленная). Задачи, поставленные
    // внутри fn и успевающие до target, тоже исполняются
    advance(ms) {
      const target = now + ms;
      for (;;) {
        tasks.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = tasks[0];
        if (!next || next.at > target) break;
        now = next.at;
        tasks.shift();
        next.fn();
      }
      now = target;
    },
    // Сколько таймеров ещё висит: проверка «жест снят без хвостов»
    pendingCount: () => tasks.length,
  };
}
