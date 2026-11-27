'use strict';

globalThis.spmStorage = (() => {
  const { aggregate, parseMatrix, parseMatrixJSON, parseMatrixDocument, fields, clean, validMonth, recordKey } = spmMetrics;
  const empty = () => ({ matrices: {}, rosters: {}, workJournal: {}, ratingSnapshots: {} });
  const format = 'spm-analysis-backup';
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
      ...record, metrics: aggregate([record]), work: spmMatrixWork.inspect(raw, record.month), trainerPosts: spmTrainers.fromMatrix(raw), rotation: spmRotation.fromMatrix(raw, record.month)
    })),
    rosters: state.rosters, workJournal: state.workJournal ?? {}
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

  async function importFiles({ files, month, department, replaceId, expectedVersion, source = 'manual', progress = () => {} }) {
    if (!files.length || files.length > 100 || (replaceId && files.length !== 1)) {
      throw new Error('Выберите от 1 до 100 файлов. Для замены выберите один файл.');
    }
    const fileIO = spmMatrixFiles;
    const results = [];
    const prepared = [];
    const batchLimit = 24 * 1024 * 1024;
    let preparedSize = 0;

    async function flush() {
      if (!prepared.length) return;
      const entries = prepared.splice(0);
      preparedSize = 0;
      progress('Сохранение матриц · ' + entries.length);
      try {
        const saved = await transact(state => entries.map(({ record, observation, raw, name, size }) => {
          const existing = state.matrices[record.id];
          let status;
          if (replaceId && (replaceId !== record.id || !existing)) {
            status = 'Участок, цех, смена или месяц не совпадают с заменяемой матрицей.';
          } else if (replaceId && expectedVersion && (existing.raw !== expectedVersion.raw || existing.importedAt !== expectedVersion.importedAt)) {
            status = 'Локальная матрица изменилась после предпросмотра. Обновите проверку.';
          } else if (existing?.raw === raw) {
            status = 'Дубликат пропущен';
          } else if (existing && !replaceId) {
            status = 'Матрица уже есть. Используйте «Заменить» в её строке.';
          } else {
            state.matrices[record.id] = { ...record, name, raw, importedAt: new Date().toISOString() };
            spmMatrixWork.append(state.workJournal ??= {}, state.matrices[record.id], observation, source === 'cloud' ? 'cloud' : 'manual');
            status = existing ? 'Заменён' : 'Загружен';
          }
          return { name, size, status };
        }));
        results.push(...saved);
      } catch (error) {
        results.push(...entries.map(({ name, size }) => ({ name, size, status: 'Не удалось сохранить: ' + error.message })));
      }
    }

    for (const [index, file] of files.entries()) {
      const { name } = file;
      const label = (index + 1) + ' из ' + files.length + ' · ' + name;
      let { size } = file;
      try {
        fileIO.checkSize(size);
        if (prepared.length && (size === undefined || preparedSize + size > batchLimit)) await flush();
        progress('Чтение JSON ' + label);
        let raw = file.raw;
        if (typeof raw === 'string') {
          size = new Blob([raw]).size;
          fileIO.checkSize(size);
        } else if (typeof file.stream === 'function') {
          ({ raw, size } = await fileIO.read(file.stream(), {
            size, progress: bytes => progress('Чтение JSON ' + label + ' · ' + fileIO.showSize(bytes))
          }));
        } else {
          throw new Error('Файл JSON недоступен для чтения.');
        }
        if (prepared.length && preparedSize + size > batchLimit) await flush();
        progress('Проверка JSON ' + label + ' · ' + fileIO.showSize(size));
        if (size >= 10 * 1024 * 1024) await fileIO.pause();
        const document = parseMatrixJSON(raw);
        const record = parseMatrixDocument(document, month, department);
        const observation = await spmMatrixWork.observation(raw, month, document);
        prepared.push({ record, observation, raw, name, size });
        preparedSize += size;
        if (preparedSize >= batchLimit) await flush();
      } catch (error) {
        // Keep the result order when a preceding small batch is still pending.
        await flush();
        results.push({ name, size: error.size ?? size, status: error instanceof RangeError
          ? 'Недостаточно памяти для обработки JSON.' : error.message });
      }
    }
    await flush();
    return { ...await snapshot(), results };
  }

  function deleteMatrix(id, expected) {
    return transact(state => {
      const existing = Object.hasOwn(state.matrices, id) ? state.matrices[id] : null;
      let status = 'missing';
      if (existing) {
        status = 'changed';
        if (expected && existing.raw === expected.raw && existing.name === expected.name
          && existing.importedAt === expected.importedAt) {
          delete state.matrices[id];
          status = 'deleted';
        }
      }
      return { data: overview(state), status };
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
    state.workJournal = spmMatrixWork.validate(source.workJournal);
    state.ratingSnapshots = spmScore.validate(source.ratingSnapshots);
    return state;
  }

  function restore(state) {
    return transact(current => {
      current.matrices = state.matrices;
      current.rosters = state.rosters;
      spmMatrixWork.merge(current.workJournal ??= {}, state.workJournal);
      spmScore.merge(current.ratingSnapshots ??= {}, state.ratingSnapshots);
      return overview(current);
    });
  }

  async function snapshot() { return overview(await read()); }

  async function ratingMatrices(month) {
    const state = await read();
    return Object.values(state.matrices).filter(record => record.month === month);
  }

  const compileScore = (state, month) => spmScore.compile(month,
    Object.values(state.matrices).filter(record => record.month === month), state.rosters[month] ?? []);

  async function scorePeriod(requested) {
    const state = await read();
    const history = state.ratingSnapshots ?? {};
    const month = validMonth(requested) ? requested : [...Object.keys(history), ...Object.keys(state.rosters),
      ...Object.values(state.matrices).map(record => record.month)].sort().at(-1)
      ?? spmMatrixWork.day(new Date().toISOString()).slice(0, 7);
    const revisions = history[month] ?? [];
    const previous = history[spmScore.previousMonth(month)]?.at(-1) ?? null;
    return { month, revisions, previous, preview: revisions.length ? null : await compileScore(state, month) };
  }

  async function saveScore(month, expectedId, reason = '') {
    if (!validMonth(month)) throw new Error('Выберите отчётный месяц.');
    reason = reason.trim();
    if ((expectedId !== null && !reason) || reason.length > 500) throw new Error('Укажите причину пересчёта до 500 символов.');
    const report = await compileScore(await read(), month);
    if (!report.rows.length) throw new Error('За выбранный месяц нет матриц и перечня ожидаемых смен.');
    return transact(state => {
      const history = (state.ratingSnapshots ??= {})[month] ??= [];
      const parent = history.at(-1);
      if ((parent?.id ?? null) !== expectedId) throw new Error('Снимок уже изменился в другой вкладке. Обновите отчёт.');
      const formedAt = new Date(Math.max(Date.now(), parent ? Date.parse(parent.formedAt) + 1 : 0)).toISOString();
      const snapshot = { ...report, id: crypto.randomUUID(), revision: (parent?.revision ?? 0) + 1,
        formedAt, parentId: expectedId, reason: expectedId === null ? '' : reason };
      history.push(snapshot);
      return snapshot;
    });
  }

  return { ratingMatrices, scorePeriod, saveScore, snapshot, start, importFiles, deleteMatrix, saveRoster, exportBackup, validateBackup, restore };
})();
