'use strict';

globalThis.spmStorage = (() => {
  const { aggregate, parseMatrix, fields, clean, validMonth, recordKey } = spmMetrics;
  const empty = () => ({ matrices: {}, rosters: {} });
  const format = 'spm-analysis-backup';
  const maxFile = 10 * 1024 * 1024;
  let database;
  let session = empty();

  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('SPM-Analysis-Desktop', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transact(change) {
    if (!database) {
      const next = structuredClone(session);
      const result = change(next);
      session = next;
      return Promise.resolve(result);
    }
    return new Promise((resolve, reject) => {
      const transaction = database.transaction('workspace', 'readwrite');
      const store = transaction.objectStore('workspace');
      const request = store.get('state');
      let result;
      let failure;
      request.onsuccess = () => {
        const state = request.result ?? empty();
        try {
          result = change(state);
          store.put(state, 'state');
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error('Запись в Edge не завершилась.'));
    });
  }

  function read() {
    if (!database) return Promise.resolve(structuredClone(session));
    return new Promise((resolve, reject) => {
      const request = database.transaction('workspace').objectStore('workspace').get('state');
      request.onsuccess = () => resolve(request.result ?? empty());
      request.onerror = () => reject(request.error);
    });
  }

  const overview = state => ({
    matrices: Object.values(state.matrices).map(({ raw, ...record }) => ({
      ...record, metrics: aggregate([record]), trainerPosts: spmTrainers.fromMatrix(raw)
    })),
    rosters: state.rosters
  });

  async function start() {
    try {
      database = await open();
      return { persistent: true, data: overview(await read()) };
    } catch {
      database?.close();
      database = undefined;
      return { persistent: false, data: overview(session) };
    }
  }

  function importFiles({ files, month, department, replaceId }) {
    if (!files.length || files.length > 100 || (replaceId && files.length !== 1)) {
      throw new Error('Выберите от 1 до 100 файлов. Для замены выберите один файл.');
    }
    return transact(state => {
      const results = files.map(({ name, raw }) => {
        try {
          if (typeof raw !== 'string' || new Blob([raw]).size > maxFile) throw new Error('Размер одного JSON ограничен 10 МБ.');
          const record = parseMatrix(raw, month, department);
          const existing = state.matrices[record.id];
          if (replaceId && (replaceId !== record.id || !existing)) {
            throw new Error('Участок, цех, смена или месяц не совпадают с заменяемой матрицей.');
          }
          if (existing?.raw === raw) return { name, status: 'Дубликат пропущен' };
          if (existing && !replaceId) return { name, status: 'Матрица уже есть. Используйте «Заменить» в её строке.' };
          state.matrices[record.id] = { ...record, name, raw, importedAt: new Date().toISOString() };
          return { name, status: existing ? 'Заменён' : 'Загружен' };
        } catch (error) { return { name, status: error.message }; }
      });
      return { ...overview(state), results };
    });
  }

  function normalizeRoster(month, rows) {
    if (!validMonth(month) || !Array.isArray(rows)) throw new Error('Некорректный месяц или перечень.');
    const roster = new Map();
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== fields.length || row.some(value => typeof value !== 'string' || !clean(value))) {
        throw new Error('В каждой строке нужны департамент, цех, участок и смена.');
      }
      const identity = Object.fromEntries(fields.map((field, index) => [field, clean(row[index])]));
      roster.set(recordKey(month, identity), identity);
    }
    return [...roster.values()];
  }

  function saveRoster(month, rows) {
    const roster = normalizeRoster(month, rows);
    return transact(state => {
      state.rosters[month] = roster;
      return overview(state);
    });
  }

  async function exportBackup() {
    return JSON.stringify({ format, version: 1, exportedAt: new Date().toISOString(), ...await read() });
  }

  function validateBackup(raw) {
    const source = JSON.parse(raw.replace(/^\uFEFF/, ''));
    const object = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!object(source) || !object(source.matrices) || !object(source.rosters) ||
        (source.format === undefined ? Object.keys(source).length !== 2 : source.format !== format || source.version !== 1)) {
      throw new Error('Выберите резервную копию SPM Analysis или прежний файл storage.json.');
    }
    const state = empty();
    for (const row of Object.values(source.matrices)) {
      if (!object(row) || typeof row.raw !== 'string' || typeof row.name !== 'string' || typeof row.department !== 'string') {
        throw new Error('Резервная копия содержит некорректную матрицу.');
      }
      const record = parseMatrix(row.raw, row.month, row.department);
      if (state.matrices[record.id]) throw new Error('Резервная копия содержит дубли матриц.');
      state.matrices[record.id] = {
        ...record, raw: row.raw, name: row.name,
        importedAt: typeof row.importedAt === 'string' ? row.importedAt : ''
      };
    }
    for (const [month, rows] of Object.entries(source.rosters)) {
      if (!Array.isArray(rows)) throw new Error('Резервная копия содержит некорректный перечень.');
      state.rosters[month] = normalizeRoster(month, rows.map(row => fields.map(field => row?.[field])));
    }
    return state;
  }

  function restore(state) {
    return transact(current => {
      current.matrices = state.matrices;
      current.rosters = state.rosters;
      return overview(current);
    });
  }

  async function ratingMatrices(month) {
    const state = await read();
    return Object.values(state.matrices).filter(record => record.month === month);
  }

  return { ratingMatrices, start, importFiles, saveRoster, exportBackup, validateBackup, restore };
})();
