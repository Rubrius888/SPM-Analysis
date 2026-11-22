'use strict';

globalThis.spmRating = (() => {
  const { calculate, aggregate, identityKey, isEligibleRole, recordKey } = spmMetrics;
  const departmentKey = record => identityKey([record.department]);
  const location = record => identityKey([record.department, record.workshop, record.section]);
  const indicators = [
    ['coveragePercent', 'Покрытие форматорами (U)'],
    ['opPercent2', 'Операторы 2L'], ['opPercent3', 'Операторы 3L'],
    ['postPercent2', 'Посты 2L'], ['postPercent3', 'Посты 3L'],
    ['total2', 'Итог ILU 2L'], ['total3', 'Итог ILU 3L']
  ];
  const isLabel = value => ['string', 'number'].includes(typeof value) && String(value).trim();

  function indexEntities(states, labels, ids, description, locations) {
    const entities = [];
    const byId = new Map();
    const byName = new Map();
    const indices = states.map(state => state[labels].map((name, index) => {
      const id = state[ids]?.[index]?.trim() || null;
      if (id && byId.has(id)) return byId.get(id);
      const entity = { id, index: entities.length };
      entities.push(entity);
      if (id) byId.set(id, entity);
      return entity;
    }));

    states.forEach((state, shift) => state[labels].forEach((name, index) => {
      const label = identityKey([locations?.[shift] ?? '', name]);
      if (!byName.has(label)) byName.set(label, []);
      byName.get(label).push({ shift, index, entity: indices[shift][index] });
    }));
    for (const occurrences of byName.values()) {
      const candidates = [...new Set(occurrences.map(entry => entry.entity))];
      if (candidates.length === 1) continue;
      const shifts = new Set(occurrences.map(entry => entry.shift));
      if (shifts.size === 1 && occurrences.every(entry => entry.entity.id)) continue;
      if (shifts.size === 1 && states.length === 1) continue;
      if (shifts.size !== occurrences.length || candidates.filter(entity => entity.id).length > 1) {
        throw new Error('Неоднозначное сопоставление: ' + description + '.');
      }
      const canonical = candidates.find(entity => entity.id) ?? candidates[0];
      for (const { shift, index } of occurrences) indices[shift][index] = canonical;
    }
    if (locations) {
      const acrossLocations = new Map();
      states.forEach((state, shift) => state[labels].forEach((name, index) => {
        const key = identityKey([name]);
        if (!acrossLocations.has(key)) acrossLocations.set(key, []);
        acrossLocations.get(key).push({ location: locations[shift], entity: indices[shift][index] });
      }));
      for (const occurrences of acrossLocations.values()) {
        if (new Set(occurrences.map(entry => entry.location)).size > 1
          && new Set(occurrences.map(entry => entry.entity)).size > 1
          && occurrences.some(entry => !entry.entity.id)) {
          throw new Error('Операторов с одинаковым именем на разных участках нельзя сопоставить без стабильных ID.');
        }
      }
    }
    if (indices.some(row => new Set(row).size !== row.length)) {
      throw new Error('Идентификаторы объединяют разные записи одной смены: ' + description + '.');
    }
    return indices;
  }

  function validateIdentity(state, labels, ids) {
    if (!Array.isArray(state[labels]) || !state[labels].every(isLabel)) return false;
    const values = state[ids];
    if (values == null) return true;
    if (!Array.isArray(values) || values.length !== state[labels].length
      || !values.every(id => id == null || typeof id === 'string')) return false;
    const present = values.map(id => id?.trim()).filter(Boolean);
    return new Set(present).size === present.length;
  }

  function mergedMetrics(records, wholeDepartment) {
    const metrics = {};
    const warnings = [];
    let states;
    let posts;
    try {
      states = records.map(({ raw }) => {
        const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
        const state = json.state ?? json;
        if (!validateIdentity(state, 'posts', 'postIds') || !Array.isArray(state.operators)
          || !Array.isArray(state.data) || state.data.length !== state.posts.length
          || !state.data.every(row => Array.isArray(row) && row.length === state.operators.length)) {
          throw new Error('В JSON не хватает данных о постах или квалификациях, либо ID постов повторяются.');
        }
        return state;
      });
      const byLocation = Map.groupBy(states.keys(), index => location(records[index]));
      posts = new Array(states.length);
      for (const indices of byLocation.values()) {
        const local = indexEntities(indices.map(index => states[index]), 'posts', 'postIds', 'посты');
        indices.forEach((index, position) => { posts[index] = local[position]; });
      }
      const uniquePosts = new Map([...new Set(posts.flat())].map(post => [post, false]));
      for (const [shift, record] of records.entries()) {
        const coverage = spmTrainers.fromMatrix(record.raw);
        if (!coverage) throw new Error('Исходных данных недостаточно для покрытия U.');
        coverage.forEach((post, index) => {
          if (post.covered) uniquePosts.set(posts[shift][index], true);
        });
      }
      const trainerPosts = [...uniquePosts.values()].map((covered, index) => ({ name: String(index), id: null, covered }));
      const coverage = spmTrainers.aggregate([{ ...records[0], trainerPosts }]);
      if (coverage) metrics.coveragePercent = coverage.coveragePercent;
      else warnings.push('Исходных данных недостаточно для покрытия U.');
    } catch (error) {
      return { metrics, warnings: [error.message], shifts: 0 };
    }

    try {
      if (states.some(state => !validateIdentity(state, 'operators', 'operatorIds')
        || !Array.isArray(state.operatorRoles) || state.operatorRoles.length !== state.operators.length
        || !state.operatorRoles.every(role => typeof role === 'string'))) {
        throw new Error('В JSON не хватает данных об операторах или повторяются их ID.');
      }
      const operators = indexEntities(states, 'operators', 'operatorIds', 'операторы',
        wholeDepartment ? records.map(location) : undefined);
      const uniquePosts = [...new Set(posts.flat())];
      const uniqueOperators = [...new Set(operators.flat())];
      const byPost = new Map(uniquePosts.map(post => [post, new Map()]));
      const roles = new Map();
      for (const [shift, state] of states.entries()) {
        for (const [index, operator] of operators[shift].entries()) {
          const role = state.operatorRoles[index];
          if (roles.has(operator) && isEligibleRole(roles.get(operator)) !== isEligibleRole(role)) {
            throw new Error('У одного оператора разные правила учёта по роли в матрицах смен.');
          }
          roles.set(operator, role);
        }
        for (const [row, post] of posts[shift].entries()) {
          const qualifications = byPost.get(post);
          for (const [col, operator] of operators[shift].entries()) {
            const level = state.data[row][col];
            if (level === 'U' || (level === 'L' && !qualifications.has(operator))) qualifications.set(operator, level);
          }
        }
      }
      const counts = calculate({
        posts: uniquePosts,
        operators: uniqueOperators,
        operatorRoles: uniqueOperators.map(operator => roles.get(operator)),
        data: uniquePosts.map(post => uniqueOperators.map(operator => byPost.get(post).get(operator) ?? null))
      });
      Object.assign(metrics, aggregate([{ counts }]));
    } catch (error) {
      warnings.push(error.message);
    }
    return { metrics, warnings, shifts: Object.keys(metrics).length ? records.length : 0 };
  }

  function build(records, roster, month, wholeDepartment = false) {
    const groupKey = wholeDepartment ? departmentKey : location;
    const expectedByLocation = Map.groupBy(roster, groupKey);
    const uniqueRecords = [...new Map(records.map(record => [record.id, record])).values()];
    return [...Map.groupBy(uniqueRecords, groupKey)].map(([id, matrices]) => {
      const { department, workshop, section } = matrices[0];
      const expected = expectedByLocation.get(id) ?? [];
      const loaded = new Set(matrices.map(record => record.id));
      const registered = new Set(expected.map(record => recordKey(month, record)));
      const missing = expected.filter(record => !loaded.has(recordKey(month, record)));
      const extra = matrices.filter(record => !registered.has(record.id));
      const completeness = expected.length
        ? missing.length || extra.length ? 'Неполная выборка' : 'Полная выборка'
        : 'Полнота не подтверждена';
      const totals = mergedMetrics(matrices, wholeDepartment);
      return {
        id, department, workshop, section: wholeDepartment ? department : section,
        matrices, expected, missing, extra, completeness, ...totals,
        ...(wholeDepartment && {
          sections: new Set(matrices.map(location)).size,
          shifts: new Set(matrices.map(record => identityKey([record.shift]))).size
        })
      };
    });
  }

  const compare = (a, b) => a.section.localeCompare(b.section, 'ru')
    || a.department.localeCompare(b.department, 'ru') || a.workshop.localeCompare(b.workshop, 'ru')
    || a.id.localeCompare(b.id);

  function rank(sections, metric) {
    return sections.toSorted((a, b) => (b.metrics[metric] ?? -1) - (a.metrics[metric] ?? -1) || compare(a, b));
  }
  return { build, indicators, rank };
})();
