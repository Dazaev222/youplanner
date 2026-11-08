// Применение слитого снимка — гонка двух устройств (см. syncToCloudNow).
// Перенесено из sync.js (applyMergedFromCloud, mergeSectionKey) без смены
// поведения: хардкод заменён лупом по дескрипторам CLOUD_SECTIONS
// (js/sync/sections.js — матрица АДР §2). Те же три фазы, что у
// applyCloudData: сбор stage без записей, снимок прежнего состояния,
// запись с откатом — фаза записи целиком в writeStaged (apply-engine.js,
// он же эмитит storage:error на отказе записи). Разделы, которые слияние
// не меняло, не пишутся вовсе: sync:applied и перерисовка — только на
// реальные изменения. Пишем прямо в хранилище: saveX поставили бы отправку
// на каждый раздел, а здесь вся порция уезжает текущим PUT.
//
// Ключ хранилища для раздела слияния читается из дескриптора (row.key);
// null — раздел без своего ключа (таких в слитом снимке быть не должно).
// Метки записи переносит не список ENVELOPE_SECTIONS, а row.writeTs === true
// у конвертных строк матрицы.
import { bus } from '../core/bus.js';
import { loadArchive } from '../data/archive.js';
import { loadFast } from '../data/fast.js';
import { loadHabits, loadTombstones, pruneResolvedTombstones } from '../data/habits.js';
import { loadPrayer } from '../data/prayer.js';
import { loadQaza, loadQazaLog } from '../data/qaza.js';
import { loadRecords } from '../data/records.js';
import { loadSchedule } from '../data/schedule.js';
import { loadSleep } from '../data/sleep.js';
import {
  SECTION_WRITE_TS_KEY, STORAGE_KEYS, loadSectionWriteTs, sectionWriteTsJson,
} from '../data/storage.js';
import { MATRIX_STORAGE_KEY } from '../data/matrix.js';
import { syncPending, syncTs } from './core.js';
import { mergeCloudIntoLocal, unwrapSection } from './merge.js';
import { CLOUD_SECTIONS } from './sections.js';
import { planPlannerApply, writeStaged } from './apply-engine.js';

// Слияние облачного снимка с локальным состоянием и запись изменившихся
// разделов. Разделы, которые слияние не меняло, не пишутся вовсе (см.
// шапку); stage собирается без записей, сравнением «до/после» по каждой
// строке матрицы CLOUD_SECTIONS.
export function applyMergedFromCloud(previous) {
  const local = {
    habits: loadHabits(),
    records: loadRecords(),
    qaza: loadQaza(true),
    prayer: loadPrayer() || {},
    fast: loadFast() || null,
    qazaLog: loadQazaLog() || null,
    sleep: loadSleep() || null,
    schedule: loadSchedule(),
    archive: loadArchive(),
    tombstones: loadTombstones(),
  };
  // Метки записи цельных разделов: слияние сравнивает по ним конверты
  // (P1-3), а победившая метка переносится в карту тем же stage ниже
  const sectionWrites = loadSectionWriteTs();
  const merged = mergeCloudIntoLocal(local, previous, {
    pending: syncPending,
    localTs: syncTs(),
    sectionWrites: sectionWrites,
  });
  // plannerV1 сливается независимо от «ок новее» соседних разделов:
  // CRDT-состояние разрешают Lamport-версии, а не метка снимка; старый
  // узел plannerV1 всё равно не может «воскресить» локальные tombstones
  const plannerStage = planPlannerApply(previous.plannerV1);
  if (!merged && !plannerStage) return;

  const stage = [];
  if (merged) {
    for (let i = 0; i < CLOUD_SECTIONS.length; i++) {
      const row = CLOUD_SECTIONS[i];
      if (!row.key) continue;
      const before = local[row.name] === undefined ? null : local[row.name];
      const after = merged[row.name] === undefined ? null : merged[row.name];
      if (JSON.stringify(before) === JSON.stringify(after)) continue;
      stage.push({ key: row.key, value: JSON.stringify(after), section: row.name });
    }
  }
  if (plannerStage) {
    stage.push({ key: STORAGE_KEYS.plannerEnvelope, value: plannerStage.envValue });
    stage.push({ key: MATRIX_STORAGE_KEY, value: plannerStage.tasksValue });
  }
  if (stage.length === 0) return;

  // Победивший в слиянии конверт переносит свою метку в локальную карту тем
  // же stage: раздел поменял содержимое — значит, выиграла облачная сторона
  // (цельные разделы сливаются целиком), и следующее сравнение должно идти
  // от её метки записи. Откат фазы записи возвращает и карту. Только
  // конвертные разделы (row.writeTs === true в матрице): у коллекций
  // (habits, records…) меток записи нет.
  const writeTsUpdates = {};
  for (let i = 0; i < stage.length; i++) {
    let writesTs = false;
    for (let j = 0; j < CLOUD_SECTIONS.length; j++) {
      if (CLOUD_SECTIONS[j].name === stage[i].section &&
          CLOUD_SECTIONS[j].writeTs === true) {
        writesTs = true;
        break;
      }
    }
    if (!writesTs) continue;
    const incoming = unwrapSection(previous[stage[i].section]);
    if (incoming.ts > 0) writeTsUpdates[stage[i].section] = incoming.ts;
  }
  const writeTsJson = sectionWriteTsJson(writeTsUpdates);
  if (writeTsJson) stage.push({ key: SECTION_WRITE_TS_KEY, value: writeTsJson });

  // Запись с откатом (фаза 3) целиком в writeStaged: на отказе записи он
  // сам эмитит storage:error — здесь просто выходим без sync:applied.
  if (!writeStaged(stage)) return;

  // Слитый список мог вернуть удалённые привычки (чужая правка победила
  // надгробие): их метки снимаются, иначе уехали бы наверх при этом же PUT
  pruneResolvedTombstones();
  // Слияние уже в хранилище: подписчик sync:applied перечитает состояние,
  // запустит архивацию (снимок мог принести старую детализацию) и перерисует
  // видимый экран
  bus.emit('sync:applied');
}
