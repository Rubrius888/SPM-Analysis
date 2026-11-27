'use strict';

(() => {
  const status = { approved: 'Утверждён', pending: 'Не утверждён', absent: 'Не сформирован', unknown: 'Нет данных' };
  const { identityKey, recordKey, isEligibleRole } = spmMetrics;
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const ratio = (part, total) => total ? part / total * 100 : null;
  const previous = month => {
    if (!month) return '';
    const date = new Date(month + '-01T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 7);
  };

  function fromMatrix(raw, month) {
    const unavailable = { status: 'unknown', approvedAt: '', people: null, cells: null };
    try {
      const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const s = json.state ?? json;
      const plans = json.plans;
      const hasHistory = object(plans?.rotationHistory);
      const legacy = plans?.rotation;
      const [year, number] = month.split('-').map(Number);
      const plan = plans?.rotationHistory?.[month] ?? (Number(legacy?.year) === year && Number(legacy?.month) === number - 1 ? legacy : null);
      const approvals = s.rotationApprovals;
      if (!plan) return { ...unavailable, status: hasHistory && !approvals?.[month] ? 'absent' : 'unknown' };
      if (!Array.isArray(plan.rows) || plan.year !== year || plan.month !== number - 1) return unavailable;
      const approval = approvals?.[month];
      const state = !object(approvals) || (approval && approval.status !== 'approved')
        ? 'unknown' : approval ? 'approved' : 'pending';
      const result = { ...unavailable, status: state, approvedAt: state === 'approved' ? approval.approvedAt ?? '' : '' };
      if (!Array.isArray(s.placementLog)) return result;
      const currentIds = new Map(s.operators.map((name, i) => [name, s.operatorIds?.[i]]));
      const allowed = new Set(s.operators.filter((name, i) => name && isEligibleRole(s.operatorRoles[i])));
      const historical = Array.isArray(plan.operatorIds) && Array.isArray(plan.operatorRoles);
      const historicalIds = Array.isArray(plan.operatorIds) ? plan.operatorIds : null;
      const entries = historical
        ? historicalIds.flatMap((id, i) => id && isEligibleRole(plan.operatorRoles[i]) ? [{ id, name: plan.operators?.[i] }] : [])
        : Array.isArray(plan.operators)
          ? plan.operators.filter(name => allowed.has(name)).map(name => ({ id: currentIds.get(name), name }))
          : null;
      const currentMonth = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(new Date());
      const numerator = new Map();
      const keyOf = person => person.id || person.name;
      const unique = values => {
        const found = new Set(), repeated = new Set();
        for (const name of values) { if (found.has(name)) repeated.add(name); else found.add(name); }
        return name => found.has(name) && !repeated.has(name);
      };
      const uniqueOperator = unique(s.operators);
      const uniquePost = unique(s.posts);
      const logs = Map.groupBy(s.placementLog, entry => String(entry?.date || '').trim());
      const cells = [];
      const allowedHistory = historical ? new Set(entries.map(person => person.id)) : null;
      for (const [row, values] of plan.rows.entries()) {
        if (!Array.isArray(values)) return result;
        const post = (plan.posts || s.posts)[row];
        for (const [column, value] of values.slice(1).entries()) {
          const name = String(value || '').trim();
          if (!name || name === '+' || name.startsWith('ДС:') || !allowed.has(name)) continue;
          const day = String(column + 1).padStart(2, '0');
          const iso = month + '-' + day;
          const operatorId = s.operatorIds?.[s.operators.indexOf(name)];
          const postId = s.postIds?.[s.posts.indexOf(post)];
          const fact = [...(logs.get(iso) || []), ...(logs.get(day + '.' + month.slice(5) + '.' + year) || [])].some(entry =>
            operatorId && postId && entry.operatorId && entry.postId
              ? entry.operatorId === operatorId && entry.postId === postId
              : uniqueOperator(name) && uniquePost(post) && entry.opName === name && entry.postName === post);
          if (state === 'approved') cells.push({ date: iso, post, postId, name, id: operatorId, fact });
          const historicalIndex = Array.isArray(plan.operators) ? plan.operators.indexOf(name) : -1;
          const id = historicalIds ? historicalIds[historicalIndex] : operatorId;
          if (fact && (!allowedHistory || allowedHistory.has(id))) numerator.set(keyOf({ id, name }), { id, name });
        }
      }
      const denominator = entries ?? (month === currentMonth ? s.operators.filter(name => allowed.has(name))
        .map(name => ({ name, id: currentIds.get(name) })) : null);
      result.people = denominator ? { eligible: [...new Map(denominator.map(person => [keyOf(person), person])).values()], rotated: [...numerator.values()] } : null;
      result.cells = state === 'approved' ? cells : null;
      return result;
    } catch { return unavailable; }
  }

  function summarize(records, roster, month) {
    const expected = new Map(roster.map(record => [recordKey(month, record), record]));
    const loaded = new Map(records.map(record => [record.id, record]));
    const rows = [...new Set([...expected.keys(), ...loaded.keys()])].map(id => {
      const record = loaded.get(id);
      return { ...expected.get(id), ...record, id, rotation: record?.rotation ?? { status: 'unknown' } };
    });
    const counts = { approved: 0, pending: 0, absent: 0, unknown: 0 };
    const eligible = new Set(), rotated = new Set(), cells = new Map();
    const legacyNames = new Map(), cellAliases = new Map();
    let anyPeople = false, anyCells = false, ambiguousCells = false;
    const identity = (row, person) => {
      const dept = identityKey([row.department]);
      if (person.id) return JSON.stringify([dept, 'id', person.id]);
      return JSON.stringify([dept, row.id, 'name', person.name]);
    };
    for (const row of rows) {
      const r = row.rotation;
      if (!expected.size || expected.has(row.id)) counts[r.status]++;
      if (r.people) {
        anyPeople = true;
        for (const person of r.people.eligible) {
          const key = identity(row, person);
          eligible.add(key);
          if (person.name) {
            const name = identityKey([row.department, person.name]);
            if (!legacyNames.has(name)) legacyNames.set(name, { keys: new Set(), fallback: false });
            const match = legacyNames.get(name);
            match.keys.add(key);
            if (!person.id) match.fallback = true;
          }
        }
        for (const person of r.people.rotated) rotated.add(identity(row, person));
      }
      if (r.cells) {
        anyCells = true;
        const occurrences = new Map();
        for (const cell of r.cells) {
          const location = identityKey([row.department, row.workshop, row.section]);
          const key = JSON.stringify([location, cell.postId || cell.post, cell.date, identity(row, cell)]);
          const alias = JSON.stringify([location, cell.post, cell.date, cell.name]);
          const prior = cellAliases.get(alias);
          const fallback = !cell.id || !cell.postId;
          if (prior && prior.key !== key && (prior.fallback || fallback)) ambiguousCells = true;
          cellAliases.set(alias, { key, fallback });
          const n = occurrences.get(key) || 0;
          occurrences.set(key, n + 1);
          const occurrence = JSON.stringify([key, n]);
          cells.set(occurrence, cells.get(occurrence) || cell.fact);
        }
      }
    }
    const ambiguous = [...legacyNames.values()].some(match => match.fallback && match.keys.size > 1);
    const planned = anyCells && !ambiguousCells ? cells.size : null;
    const executed = anyCells && !ambiguousCells ? [...cells.values()].filter(Boolean).length : null;
    return { rows, counts, expected: expected.size, ambiguous, ambiguousCells,
      eligible: anyPeople && !ambiguous ? eligible.size : null,
      rotated: anyPeople && !ambiguous ? rotated.size : null, planned, executed,
      rotationCoverage: anyPeople && !ambiguous ? ratio(rotated.size, eligible.size) : null,
      rotationExecution: ratio(executed, planned), rotationApproval: counts.unknown < expected.size ? ratio(counts.approved, expected.size) : null };
  }
  globalThis.spmRotation = { fromMatrix, summarize, status, previous, ratio };
})();
