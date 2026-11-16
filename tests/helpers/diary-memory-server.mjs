// Тестовый in-memory RTDB-транспорт: create-only, потери ответа, offline,
// permission-denied. Не является доказательством работы реальных Firebase Rules.

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function createMemoryServer() {
  const data = new Map();
  const creates = [];
  const state = {
    offline: false,
    permissionDenied: false,
    loseResponseFor: new Set(),
  };

  function isAllowed(path) {
    return !state.permissionDenied && path.startsWith('diaryV1/');
  }

  const transport = {
    async get(path) {
      if (state.offline) return { ok: false, error: { code: 'OFFLINE', message: 'offline' } };
      if (!isAllowed(path)) {
        return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'denied' } };
      }
      if (data.has(path)) return { ok: true, value: clone(data.get(path)) };

      // RTDB GET родителя отдаёт поддерево потомков.
      const prefix = `${path}/`;
      const children = [...data.keys()].filter((key) => key.startsWith(prefix));
      if (children.length === 0) return { ok: true, value: null };
      const tree = {};
      for (const key of children) {
        const parts = key.slice(prefix.length).split('/');
        let cursor = tree;
        for (let i = 0; i < parts.length - 1; i += 1) {
          if (!cursor[parts[i]] || typeof cursor[parts[i]] !== 'object') cursor[parts[i]] = {};
          cursor = cursor[parts[i]];
        }
        cursor[parts[parts.length - 1]] = clone(data.get(key));
      }
      return { ok: true, value: tree };
    },

    async create(path, value) {
      if (state.offline) return { ok: false, error: { code: 'OFFLINE', message: 'offline' } };
      if (!isAllowed(path)) {
        return { ok: false, error: { code: 'PERMISSION_DENIED', message: 'denied' } };
      }
      if (data.has(path)) {
        return { ok: false, error: { code: 'CONFLICT', message: 'exists' } };
      }
      creates.push({ path, value: clone(value) });
      data.set(path, clone(value));
      if (state.loseResponseFor.has(path)) {
        state.loseResponseFor.delete(path);
        return { ok: false, error: { code: 'UNKNOWN', message: 'response lost' } };
      }
      return { ok: true, value: clone(value) };
    },

    // Прямая запись только для подготовки серверного состояния в тестах.
    async _seed(path, value) {
      data.set(path, clone(value));
    },
    async _get(path) {
      return data.has(path) ? clone(data.get(path)) : null;
    },
    _has(path) {
      return data.has(path);
    },
  };

  return { transport, state, creates, data };
}
