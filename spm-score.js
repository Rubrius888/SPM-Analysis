'use strict';

globalThis.spmScore = (() => {
  const { clean, identityKey, recordKey, validMonth } = spmMetrics;
  const version = '1.3';
  const normalizedVersion = '1.2';
  const rawVersion = '1.1';
  const legacyVersion = '1.0';
  const directions = [
    ['Поливалентность', [
      ['opPercent2', 'Операторы 2L', 10.6, 'Матрицы ILU · квалификации L/U и роли', 7],
      ['opPercent3', 'Операторы 3L', 10.6, 'Матрицы ILU · квалификации L/U и роли', 7],
      ['postPercent2', 'Посты 2L', 10.6, 'Матрицы ILU · квалификации L/U и роли', 7],
      ['postPercent3', 'Посты 3L', 10.6, 'Матрицы ILU · квалификации L/U и роли', 7],
      ['coveragePercent', 'Покрытие форматорами U', 10.6, 'Матрицы ILU · хотя бы один U на посту', 7]
    ]],
    ['Ротация', [
      ['rotationCoverage', 'Охват ротацией', 19, 'План ротации и журнал фактических назначений ILU', 12.5],
      ['rotationExecution', 'Процент выполнения плана ротации', 19, 'Утверждённый план ротации и фактические назначения ILU', 12.5]
    ]],
    ['Управление матрицей', [
      ['rotationFormed', 'Формирование плана ротации', 3, 'Работа с матрицей · plans.rotationHistory, перечень смен', 2],
      ['rotationApproved', 'Утверждение плана ротации', 3, 'Работа с матрицей · state.rotationApprovals, перечень смен', 2],
      ['developmentFormed', 'Формирование плана развития', 3, 'Работа с матрицей · plans.developmentHistory, перечень смен', 2]
    ]]
  ];
  const maximum = 100;
  const priorMaximum = directions.reduce((sum, [, list]) => list.reduce((total, [, , , , priorWeight]) => total + priorWeight, sum), 0);
  const weights = new Map(directions.flatMap(([, list]) => list.map(([key, , weight]) => [key, weight])));
  const pointUnits = 10000;
  const normalizedArchiveValue = value => value / priorMaximum * maximum;
  const round = (value, units) => Math.round((value + Number.EPSILON) * units) / units;
  const isPercent = value => Number.isFinite(value) && value >= 0 && value <= 100;
  const siteKey = row => identityKey([row.department, row.workshop, row.section]);

  function score(values) {
    let rankingPoints = 0;
    const parts = directions.map(([label, definitions]) => {
      let rankingPart = 0;
      const indicators = definitions.map(([key, name, weight, source, priorWeight]) => {
        const { value, reason } = values[key] ?? {};
        const percent = isPercent(value) ? value : null;
        const points = percent === null ? 0 : percent * weight / 100;
        if (percent !== null) rankingPart += round(percent * priorWeight / 100, pointUnits);
        return { key, name, weight, source, percent, points,
          status: percent === null ? 'Нет данных' : 'Рассчитан',
          reason: percent === null ? reason ?? 'Недостаточно подтверждённых исходных данных.'
            : percent === 0 ? 'Подтверждённое значение составляет 0%.' : '' };
      });
      rankingPoints += round(rankingPart, pointUnits);
      return { label, indicators, weight: indicators.reduce((sum, item) => sum + item.weight, 0),
        points: indicators.reduce((sum, item) => sum + item.points, 0) };
    });
    // Places still use the same comparison and tie key as methodology 1.2.
    return { parts, total: parts.reduce((sum, part) => sum + part.points, 0), rankingScore: round(rankingPoints, 100),
      preliminary: parts.some(part => part.indicators.some(item => item.percent === null)) };
  }

  function workflowPercent(records, roster, month) {
    const expected = new Set(roster.map(row => recordKey(month, row)));
    const facts = records.filter(row => expected.has(row.id)).map(row => spmMatrixWork.inspect(row.raw, month));
    const checks = [
      ['rotationFormed', fact => fact.rotation.formed, 'formed'],
      ['rotationApproved', fact => fact.rotation.approved, 'approved'],
      ['developmentFormed', fact => fact.development.formed, 'formed']
    ];
    return Object.fromEntries(checks.map(([key, status, success]) => {
      const observed = facts.map(status);
      const value = observed.some(item => item !== 'unknown')
        ? observed.filter(item => item === success).length / expected.size * 100 : null;
      return [key, { value, reason: !expected.size ? 'Перечень ожидаемых смен не задан.'
        : 'По ожидаемым сменам нет ни одного подтверждённого статуса.' }];
    }));
  }

  async function matrixVersion(record) {
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(record.raw));
    return { id: record.id, name: record.name, importedAt: record.importedAt,
      fingerprint: Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('') };
  }

  function rank(rows) {
    const positionScore = row => row.rankingScore ?? row.total;
    const sorted = rows.toSorted((a, b) => positionScore(b) - positionScore(a) || a.section.localeCompare(b.section, 'ru')
      || a.department.localeCompare(b.department, 'ru') || a.workshop.localeCompare(b.workshop, 'ru') || a.id.localeCompare(b.id));
    let place;
    return sorted.map((row, index) => {
      if (!index || positionScore(row) !== positionScore(sorted[index - 1])) place = index + 1;
      return { ...row, place };
    });
  }

  async function compile(month, matrices, roster) {
    const input = [...new Map(matrices.map(record => [record.id, record])).values()];
    const rankings = new Map(spmRating.build(input, roster, month).map(row => [row.id, row]));
    const expectedBySite = Map.groupBy(roster, siteKey);
    const sites = new Map([...roster, ...input].map(row => [siteKey(row), row]));
    const rows = await Promise.all([...sites].map(async ([id, site]) => {
      const existing = rankings.get(id);
      const records = existing?.matrices ?? [];
      const expected = expectedBySite.get(id) ?? [];
      const expectedIds = expected.map(row => recordKey(month, row));
      const values = Object.fromEntries(Object.entries(existing?.metrics ?? {}).map(([key, value]) => [key, { value }]));
      const reasons = !records.length ? 'За месяц не загружены матрицы участка.'
        : existing.warnings.length ? existing.warnings.join(' ') : 'В источниках за месяц нет достаточных данных для расчёта.';
      for (const key of ['opPercent2', 'opPercent3', 'postPercent2', 'postPercent3', 'coveragePercent']) {
        values[key] ??= { reason: reasons };
      }
      for (const key of ['rotationCoverage', 'rotationExecution']) {
        values[key] ??= { reason: records.length ? 'Нет подтверждённой базы операторов, плана или сопоставимых фактических назначений за месяц.' : reasons };
      }
      Object.assign(values, workflowPercent(records, expected, month));
      const { department, workshop, section } = site;
      return { id, department, workshop, section, ...score(values),
        completeness: existing?.completeness ?? 'Неполная выборка',
        expectedIds, missing: existing ? existing.missing.length : expectedIds.length,
        extra: expected.length ? existing?.extra.length ?? 0 : 0,
        versions: await Promise.all(records.map(matrixVersion)) };
    }));
    return { month, methodology: version, maximum, preliminary: rows.some(row => row.preliminary), rows: rank(rows) };
  }

  function previousMonth(month) {
    const date = new Date(month + '-01T00:00:00Z');
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 7);
  }

  function compare(current, previous) {
    const priorRows = previous?.methodology === current.methodology ? previous.rows : [];
    const baseline = new Map(priorRows.map(row => [row.id, row]));
    return current.rows.map(row => {
      const prior = baseline.get(row.id);
      return { ...row, previousScore: prior?.total ?? null, previousPlace: prior?.place ?? null,
        scoreChange: prior ? round(row.total - prior.total, 100) : null, placeChange: prior ? prior.place - row.place : null };
    });
  }

  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const strings = (value, keys) => keys.every(key => typeof value[key] === 'string');
  const natural = value => Number.isSafeInteger(value) && value >= 0;
  const point = (value, maximum) => Number.isFinite(value) && value >= 0 && value <= maximum;
  const snapshotOrder = (a, b) => Date.parse(a.formedAt) - Date.parse(b.formedAt) || a.id.localeCompare(b.id);
  function validate(history) {
    if (history === undefined) return {};
    const indicator = item => object(item) && strings(item, ['key', 'name', 'source', 'status', 'reason'])
      && point(item.weight, 100) && point(item.points, item.weight) && (item.percent === null || isPercent(item.percent));
    const part = item => object(item) && typeof item.label === 'string' && point(item.weight, 100) && point(item.points, item.weight)
      && Array.isArray(item.indicators) && item.indicators.every(indicator);
    const matrix = item => object(item) && strings(item, ['id', 'name', 'importedAt', 'fingerprint']) && /^[0-9a-f]{64}$/.test(item.fingerprint);
    const site = (row, limit) => object(row) && strings(row, ['id', 'department', 'workshop', 'section', 'completeness'])
      && siteKey(row) === row.id && point(row.total, limit) && natural(row.place) && row.place > 0 && natural(row.missing) && natural(row.extra)
      && Array.isArray(row.expectedIds) && row.expectedIds.every(id => typeof id === 'string')
      && Array.isArray(row.versions) && row.versions.every(matrix) && Array.isArray(row.parts) && row.parts.every(part);
    const matchesDirections = (row, limit, weightFor) => site(row, limit) && typeof row.preliminary === 'boolean'
      && row.parts.length === directions.length && row.parts.every((part, index) => {
        const [label, definitions] = directions[index];
        const currentWeight = definitions.reduce((sum, [, , weight]) => sum + weight, 0);
        const priorWeight = definitions.reduce((sum, [, , , , weight]) => sum + weight, 0);
        return part.label === label && part.weight === weightFor(currentWeight, priorWeight)
          && part.indicators.length === definitions.length && part.indicators.every((indicator, j) => {
            const [key, , weight, , previousWeight] = definitions[j];
            return indicator.key === key && indicator.weight === weightFor(weight, previousWeight);
          });
      });
    function validScale(item) {
      if (item.methodology === version) {
        return item.maximum === maximum && item.rows.every(row => matchesDirections(row, maximum, weight => weight)
          && point(row.rankingScore, priorMaximum) && row.total === row.parts.reduce((sum, part) => sum + part.points, 0));
      }
      if (item.methodology === normalizedVersion) {
        return item.maximum === maximum && item.rows.every(row => matchesDirections(row, maximum, (_, prior) => normalizedArchiveValue(prior))
          && point(row.rawScore, priorMaximum) && point(row.rankingScore, priorMaximum)
          && row.total === normalizedArchiveValue(row.rawScore));
      }
      if (item.methodology === rawVersion) {
        return item.maximum === priorMaximum && item.rows.every(row => matchesDirections(row, priorMaximum, (_, prior) => prior));
      }
      return item.methodology === legacyVersion && item.rows.every(row => site(row, maximum));
    }

    const valid = (item, period) => object(item) && strings(item, ['id', 'month', 'methodology', 'formedAt', 'reason'])
      && item.month === period && Number.isFinite(Date.parse(item.formedAt)) && natural(item.revision) && item.revision > 0
      && (item.parentId === null || typeof item.parentId === 'string') && typeof item.preliminary === 'boolean'
      && Array.isArray(item.rows) && item.rows.length > 0 && validScale(item)
      && new Set(item.rows.map(row => row.id)).size === item.rows.length;
    if (!object(history) || !Object.entries(history).every(([period, snapshots]) => validMonth(period)
      && Array.isArray(snapshots) && snapshots.every(item => valid(item, period))
      && new Set(snapshots.map(item => item.id)).size === snapshots.length)) {
      throw new Error('Резервная копия содержит некорректные снимки раздела «ILU рейтинг».');
    }
    return Object.fromEntries(Object.entries(history).map(([period, snapshots]) => [period, snapshots.toSorted(snapshotOrder)]));
  }

  function merge(current, incoming = {}) {
    for (const [period, snapshots] of Object.entries(incoming)) {
      const byId = new Map((current[period] ?? []).map(item => [item.id, item]));
      for (const item of snapshots) {
        if (!byId.has(item.id)) byId.set(item.id, item);
      }
      current[period] = [...byId.values()].sort(snapshotOrder);
    }
  }

  function visibleParts(row) {
    return row.parts.flatMap(part => {
      const indicators = part.indicators.filter(item => weights.has(item.key));
      return indicators.length ? [{ ...part, indicators,
        weight: indicators.reduce((sum, item) => sum + item.weight, 0) }] : [];
    });
  }

  return { version, maximum, compile, score, rank, compare, previousMonth, validate, merge, visibleParts };
})();
