'use strict';

globalThis.spmMatrixWork = (() => {
  const { validMonth, recordKey } = spmMetrics;
  const entity = value => value && typeof value === 'object' && !Array.isArray(value);
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? value : '';
  const clock = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = value => timestamp(value) ? clock.format(new Date(value)) : '';
  const digest = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
    byte => byte.toString(16).padStart(2, '0')).join('');

  function inspect(raw, month, includeContent = false) {
    return inspectDocument(spmMetrics.parseMatrixJSON(raw), month, includeContent);
  }

  function inspectDocument(json, month, includeContent) {
    const state = json?.state ?? json ?? {};
    const [year, number] = String(month ?? '').split('-').map(Number);
    function plan(type) {
      const history = json?.plans?.[type + 'History'];
      const legacy = json?.plans?.[type];
      const matches = value => Number(value?.year) === year && Number(value?.month) === number - 1;
      const entry = history?.[month] ?? (matches(legacy) ? legacy : null);
      const approvals = state.rotationApprovals;
      const approval = approvals?.[month];
      if (!entry) {
        const absent = entity(history) && !Object.hasOwn(history, month) && !(type === 'rotation' && approval);
        return { formed: absent ? 'absent' : 'unknown', approved: 'unknown' };
      }
      if (!matches(entry) || !Array.isArray(entry.rows) || !entry.rows.every(Array.isArray)) return { formed: 'unknown', approved: 'unknown' };
      const approved = type !== 'rotation' || !entity(approvals) ? 'unknown'
        : approval?.status === 'approved' ? 'approved' : Object.hasOwn(approvals, month) ? 'unknown' : 'pending';
      return { formed: 'formed', approved, generatedAt: timestamp(entry.generatedAt),
        approvedAt: approved === 'approved' ? timestamp(approval.approvedAt) : '', ...(includeContent && { content: JSON.stringify(entry) }) };
    }
    return { exportedAt: timestamp(json?.exportedAt), rotation: plan('rotation'), development: plan('development') };
  }

  async function observation(raw, month, document = spmMetrics.parseMatrixJSON(raw)) {
    const facts = inspectDocument(document, month, true);
    const fingerprint = await digest(raw);
    for (const plan of [facts.rotation, facts.development]) {
      if (plan.content !== undefined) { plan.signature = await digest(plan.content); delete plan.content; }
    }
    return { fingerprint, ...facts };
  }

  function append(work, record, facts, source) {
    const history = work[record.id] ??= [];
    if (history.some(item => item.fingerprint === facts.fingerprint)) return;
    const prior = history.at(-1);
    const events = [{ type: 'Получена версия матрицы', status: 'received' }];
    for (const [key, title] of [['rotation', 'ротации'], ['development', 'развития']]) {
      const next = facts[key], previous = prior?.[key];
      if (next.formed === 'formed' && next.signature !== previous?.signature) {
        events.push({ type: previous?.formed === 'formed' ? 'Изменение плана ' + title : 'Обнаружен план ' + title,
          status: 'formed', actualAt: !previous?.signature ? next.generatedAt : '' });
      } else if (next.formed === 'absent' && previous?.formed !== 'absent') {
        events.push({ type: 'Обнаружено отсутствие плана ' + title, status: 'absent' });
      } else if (next.formed === 'unknown' && previous && previous.formed !== 'unknown') {
        events.push({ type: 'Статус плана ' + title + ' недоступен в новой версии', status: 'unknown' });
      }
      if (next.approved !== previous?.approved && (next.approved !== 'unknown' || previous?.approved === 'approved' || previous?.approved === 'pending')) {
        events.push({ type: next.approved === 'approved' ? 'Обнаружено утверждение плана ' + title : 'Статус утверждения плана ' + title,
          status: next.approved, actualAt: next.approvedAt });
      }
    }
    const { id, department, workshop, section, shift, month, importedAt, name } = record;
    history.push({ ...facts, id, department, workshop, section, shift, month, name, observedAt: importedAt, source, events });
  }

  function merge(current, incoming) {
    for (const [id, rows] of Object.entries(incoming ?? {})) {
      const byHash = new Map((current[id] ?? []).map(row => [row.fingerprint, row]));
      for (const row of rows) if (!byHash.has(row.fingerprint)) byHash.set(row.fingerprint, row);
      current[id] = [...byHash.values()].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    }
  }

  function validate(value) {
    if (!entity(value)) return {};
    const validPlan = plan => entity(plan) && ['formed','absent','unknown'].includes(plan.formed)
      && ['approved','pending','unknown'].includes(plan.approved);
    return Object.fromEntries(Object.entries(value).flatMap(([id, rows]) => {
      if (!Array.isArray(rows)) return [];
      const valid = rows.filter(row => entity(row) && row.id === id && validMonth(row.month)
        && spmMetrics.fields.every(key => typeof row[key] === 'string' && row[key]) && recordKey(row.month, row) === id
        && /^[0-9a-f]{64}$/.test(row.fingerprint) && timestamp(row.observedAt) && typeof row.name === 'string'
        && ['manual','cloud'].includes(row.source) && validPlan(row.rotation) && validPlan(row.development)
        && Array.isArray(row.events) && row.events.every(event => entity(event) && typeof event.type === 'string' && typeof event.status === 'string'));
      return valid.length ? [[id, valid]] : [];
    }));
  }

  function makeRows(records, roster, journal, month) {
    const expected = new Map(roster.map(row => [recordKey(month, row), row]));
    const loaded = new Map(records.map(row => [row.id, row]));
    return [...new Set([...expected.keys(), ...loaded.keys()])].map(id => {
      const row = loaded.get(id);
      const facts = row?.work;
      const exportedDay = day(facts?.exportedAt);
      const exportMonth = exportedDay.slice(0, 7);
      const today = day(new Date().toISOString());
      const age = exportedDay ? Math.floor((Date.parse(today) - Date.parse(exportedDay)) / 86400000) : null;
      return { ...expected.get(id), ...row, id, month, expected: expected.has(id), work: facts,
        history: journal[id] ?? [], age: age !== null && age >= 0 ? age : null,
        freshness: !facts || !exportMonth || exportMonth > month || age < 0 ? 'unknown' : exportMonth === month ? 'fresh' : 'older' };
    });
  }
  return { inspect, observation, append, merge, validate, makeRows, day };
})();
