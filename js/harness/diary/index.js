/* Публичный API дневника (ТЗ §9). UI не входит: только данные и ошибки Result.
   Сборка модулей: schema/ids/canonical/clock → projection/statistics →
   store/repository → sync/commands → index. */

import {
  applyAnalysis as applyAnalysisCore,
  buildAnalysisDataset,
  prepareCategoryPolicy as prepareCategoryPolicyCore,
  requestAnalysis as requestAnalysisCore,
} from './analysis.js';
import {
  executeImport, exportDiary, planImport, resumeImport, validateImport,
} from './backup.js';
import { hashSnapshot } from './canonical.js';
import { createCommands, resolveUid } from './commands.js';
import { fail, ok } from './errors.js';
import { newId } from './ids.js';
import { replayJournal } from './projection.js';
import { calculateStatistics } from './statistics.js';
import { createSyncQueue } from './sync.js';

export { ERROR_CODES } from './errors.js';
export { SCHEMA_VERSION, LIMITS, parseDuration, formatDuration } from './schema.js';

export function createDiaryService({
  auth,
  repository,
  store,
  clock,
  journalId,
  deviceId,
  crypto,
  analysisProvider,
  keyStore,
} = {}) {
  if (!repository || !store || !clock) {
    throw new TypeError('createDiaryService: нужны repository, store, clock');
  }
  const serviceJournalId = journalId || newId('journal', crypto);
  const serviceDeviceId = deviceId || newId('device', crypto);

  const commands = createCommands({
    auth,
    repository,
    store,
    clock,
    journalId: serviceJournalId,
    deviceId: serviceDeviceId,
    crypto,
  });

  const queue = createSyncQueue({ store, repository, clock });

  async function requireUidOrThrow() {
    const result = await resolveUid(auth);
    if (!result.ok) {
      const error = new Error(result.error.message);
      error.code = result.error.code;
      error.details = result.error.details;
      throw error;
    }
    return result.value;
  }

  async function withUid(fn) {
    const result = await resolveUid(auth);
    if (!result.ok) return result;
    return fn(result.value);
  }

  async function projectionFor(uid) {
    const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
    const journal = replayJournal(snapshot);
    if (!snapshot.initialization) return journal;
    const statistics = calculateStatistics({
      startedAtMs: snapshot.initialization.startedAtMs,
      events: journal.events,
      nowMs: clock.now(),
      timeZone: snapshot.initialization.timeZone,
    });
    const timeAnomaly = journal.events.some((item) => item.occurredAtMs > clock.now());
    return { ...journal, ...statistics, timeAnomaly };
  }

  async function currentProjectionResult() {
    return withUid(async (uid) => ok(await projectionFor(uid)));
  }

  // Read-only подписка: компоненты не читают IndexedDB и не повторяют replay.
  const listeners = new Set();
  let emitInFlight = null;

  async function emit() {
    if (listeners.size === 0) return;
    if (emitInFlight) return emitInFlight;
    emitInFlight = (async () => {
      const projectionResult = await currentProjectionResult();
      if (!projectionResult.ok) return;
      const syncResult = await withUid((uid) => queue.getSyncState({
        uid,
        journalId: serviceJournalId,
      }));
      const payload = {
        journalId: serviceJournalId,
        projection: projectionResult.value,
        syncState: syncResult.ok ? syncResult.value : null,
      };
      for (const listener of [...listeners]) {
        try {
          await listener(payload);
        } catch (error) {
          // Ошибка подписчика не должна ломать команду или других подписчиков.
        }
      }
    })();
    try {
      await emitInFlight;
    } finally {
      emitInFlight = null;
    }
  }

  function notifying(name) {
    const command = commands[name];
    return async (...args) => {
      const result = await command(...args);
      if (result && result.ok === true) await emit();
      return result;
    };
  }

  async function findAnalysis(uid, reference) {
    const wanted = reference && (reference.analysisId || reference.draftId);
    if (!wanted) return null;
    const drafts = await store.readAnalysisDrafts({ uid, journalId: serviceJournalId });
    const draft = drafts.find((item) => item && item.analysisId === wanted);
    if (draft) return draft;
    const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
    return snapshot.analyses[wanted] || null;
  }

  async function subscribe({ onChange } = {}) {
    if (typeof onChange !== 'function') {
      return fail('INVALID_DATA', 'Нужен onChange для подписки', { path: 'onChange' });
    }
    const initial = await currentProjectionResult();
    if (!initial.ok) return initial;
    listeners.add(onChange);
    try {
      await onChange({
        journalId: serviceJournalId,
        projection: initial.value,
        syncState: null,
      });
    } catch (error) {
      listeners.delete(onChange);
      return fail('INVALID_DATA', 'Подписчик не принял начальное состояние');
    }
    return ok({
      unsubscribe() {
        listeners.delete(onChange);
      },
    });
  }

  return {
    journalId: serviceJournalId,
    deviceId: serviceDeviceId,
    initializeDiary: notifying('initializeDiary'),
    createTrigger: notifying('createTrigger'),
    confirmRelapse: notifying('confirmRelapse'),
    prepareMutation: commands.prepareMutation,
    commitMutation: notifying('commitMutation'),
    synchronize: (options = {}) => withUid(async (uid) => {
      const result = await queue.synchronize({
        uid,
        journalId: serviceJournalId,
        ...options,
      });
      if (result.ok) await emit();
      return result;
    }),
    getSyncState: () => withUid((uid) => queue.getSyncState({
      uid,
      journalId: serviceJournalId,
    })),
    getSnapshot: async () => {
      const uid = await requireUidOrThrow();
      return store.readSnapshot({ uid, journalId: serviceJournalId });
    },
    getProjection: async () => {
      const uid = await requireUidOrThrow();
      return projectionFor(uid);
    },
    getFingerprint: async () => {
      const uid = await requireUidOrThrow();
      const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
      return hashSnapshot(snapshot);
    },
    subscribe,
    requestAnalysis: (options = {}) => withUid(async (uid) => {
      if (!analysisProvider || typeof analysisProvider.complete !== 'function') {
        return fail('INVALID_DATA', 'Провайдер анализа не настроен', { path: 'analysisProvider' });
      }
      const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
      const datasetResult = await buildAnalysisDataset({
        snapshot,
        nowMs: clock.now(),
      });
      if (!datasetResult.ok) return datasetResult;
      const requested = await requestAnalysisCore({
        dataset: datasetResult.value,
        provider: analysisProvider,
        keyStore,
        clock,
        crypto,
        signal: options.signal,
        model: options.model,
        maxEventsPerChunk: options.maxEventsPerChunk,
        maxChunks: options.maxChunks,
      });
      if (!requested.ok) return requested;
      const draft = requested.value.draft;
      const saved = await store.saveAnalysisDraft({
        uid,
        journalId: serviceJournalId,
        draftId: draft.analysisId,
        payload: draft,
      });
      if (!saved.ok) return saved;
      return requested;
    }),
    prepareCategoryPolicy: ({ draftId, analysisId, proposal, categories, triggerMappings } = {}) =>
      withUid(async (uid) => {
        const source = await findAnalysis(uid, { analysisId, draftId });
        const effectiveProposal = proposal || (source && source.proposal);
        if (!effectiveProposal) {
          return fail('DEPENDENCY_MISSING', 'Предложение анализа не найдено', {
            path: 'analysisId',
          });
        }
        const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
        const projection = replayJournal(snapshot);
        const policy = prepareCategoryPolicyCore({
          proposal: effectiveProposal,
          currentPolicy: projection.policy,
          triggers: projection.triggers,
          analysisId: source ? source.analysisId : analysisId,
          categories,
          triggerMappings,
        });
        if (!policy.ok) return policy;
        const prepared = await commands.prepareMutation({
          entityKey: 'categoryPolicy',
          changes: policy.value.changes,
          type: 'applyCategoryPolicy',
        });
        if (!prepared.ok) return prepared;
        return ok({
          proposal: {
            ...prepared.value,
            analysisId: source ? source.analysisId : analysisId,
            sourceFingerprint: source ? source.sourceFingerprint : undefined,
          },
          changes: policy.value.changes,
        });
      }),
    applyAnalysis: ({ proposal, analysis, analysisId, draftId, consent } = {}) =>
      withUid(async (uid) => {
        const referenceId = analysisId || draftId
          || (proposal && proposal.analysisId);
        const source = analysis || await findAnalysis(uid, { analysisId: referenceId });
        const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
        const applied = await applyAnalysisCore({
          analysis: source,
          proposal,
          snapshot,
          commands,
          consent,
        });
        if (applied.ok) await emit();
        return applied;
      }),
    importBackup: ({ plan, sessionId, onEntry } = {}) => withUid(async (uid) => {
      const result = !plan && sessionId
        ? await resumeImport({
          sessionId,
          store,
          repository,
          clock,
          uid,
          journalId: serviceJournalId,
          onEntry,
        })
        : await executeImport({
          plan,
          store,
          repository,
          clock,
          uid,
          journalId: serviceJournalId,
          onEntry,
        });
      if (result.ok) await emit();
      return result;
    }),
    resumeBackupImport: ({ sessionId, onEntry } = {}) => withUid(async (uid) => {
      const result = await resumeImport({
        sessionId,
        store,
        repository,
        clock,
        uid,
        journalId: serviceJournalId,
        onEntry,
      });
      if (result.ok) await emit();
      return result;
    }),
    exportBackup: () => withUid(async (uid) => {
      const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
      return exportDiary(snapshot, clock.now());
    }),
    validateBackup: (text) => validateImport(text),
    planBackupImport: (validated, options = {}) => withUid(async (uid) => {
      const snapshot = await store.readSnapshot({ uid, journalId: serviceJournalId });
      return planImport(validated, snapshot, {
        journalId: serviceJournalId,
        ...options,
      });
    }),
    analysisProvider,
    keyStore,
  };
}
