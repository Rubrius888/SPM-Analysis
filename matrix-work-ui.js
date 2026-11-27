'use strict';

globalThis.spmMatrixWorkUI = (() => {
  const api = spmMatrixWork;
  const fields = ['department', 'workshop', 'section', 'shift'];
  const labels = ['Департамент', 'Цех', 'Участок', 'Смена'];
  const time = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' });
  const names = { fresh: 'Экспорт в выбранном месяце', older: 'Экспорт до выбранного месяца', unknown: 'Нет данных',
    formed: 'Сформирован', absent: 'Не сформирован', approved: 'Утверждён', pending: 'Не утверждён', received: 'Получена версия' };
  const metrics = [
    ['fresh', 'Актуальные матрицы', row => row.freshness === 'fresh', row => row.freshness !== 'unknown'],
    ['rotationFormed', 'Сформированные планы ротации', row => row.work?.rotation.formed === 'formed', row => known(row, 'rotation', 'formed')],
    ['rotationApproved', 'Утверждённые планы ротации', row => row.work?.rotation.approved === 'approved', row => known(row, 'rotation', 'approved')],
    ['developmentFormed', 'Сформированные планы развития', row => row.work?.development.formed === 'formed', row => known(row, 'development', 'formed')],
    ['developmentApproved', 'Утверждённые планы развития', row => row.work?.development.approved === 'approved', row => known(row, 'development', 'approved')]
  ];
  const dialog = byId('matrixWorkDialog');
  let view, detailRows, sort = { index: -1, direction: 1 };
  const fmt = value => Number.isFinite(Date.parse(value)) ? time.format(new Date(value)) : '—';
  const pct = value => value === null ? '—' : value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%';
  function known(row, type, kind) { return !!row.work && row.work[type][kind] !== 'unknown'; }
  function quantity(rows, test, available) {
    const expected = rows.filter(row => row.expected);
    const usable = expected.length ? expected : rows;
    const count = usable.some(available) ? usable.filter(test).length : null;
    return { count, total: expected.length, percent: count !== null && expected.length
      ? Number((100 * count / expected.length).toFixed(1)) : null };
  }
  function issue(row) {
    return row.freshness === 'older' || ['rotation', 'development'].some(type =>
      row.work?.[type].formed === 'absent' || row.work?.[type].approved === 'pending');
  }
  function insufficient(row) {
    return row.freshness === 'unknown' || ['rotation', 'development'].some(type => {
      const plan = row.work?.[type];
      return !plan || plan.formed === 'unknown' || (plan.formed === 'formed' && plan.approved === 'unknown');
    });
  }
  function badge(value) {
    const style = { formed: 'approved', fresh: 'approved', older: 'pending' }[value] || value;
    return element('span', names[value] || value, 'rotation-status rotation-' + style);
  }
  function showDetail(row) {
    const location = spmMetrics.identityKey(fields.slice(0,3).map(field => row[field]));
    detailRows = view.details.filter(item => spmMetrics.identityKey(fields.slice(0,3).map(field => item[field])) === location);
    const select = byId('matrixWorkShift');
    select.replaceChildren(...detailRows.map(item => new Option(item.shift, item.id)));
    select.value = row.id;
    drawDetail(row);
    if (!dialog.open) dialog.showModal();
  }

  function drawDetail(row) {
    byId('matrixWorkTitle').textContent = row.section;
    const host = byId('matrixWorkDetails');
    host.replaceChildren(element('p', row.department + ' / ' + row.workshop),
      badge(row.freshness), element('p', 'Последний доступный JSON: ' + (row.name ?? '—') + ' · экспорт: ' + fmt(row.work?.exportedAt)));
    for (const [kind, title] of [['rotation', 'Ротация'], ['development', 'Развитие']]) {
      const plan = row.work?.[kind];
      const text = element('p', title + ' · ');
      text.append(badge(plan?.formed || 'unknown'), ' · ', badge(plan?.approved || 'unknown'));
      if (plan?.generatedAt) text.append(' · сформирован: ' + fmt(plan.generatedAt));
      if (plan?.approvedAt) text.append(' · утверждён: ' + fmt(plan.approvedAt));
      host.append(text);
    }
    const match = item => spmMetrics.identityKey(fields.map(field => item[field])) === spmMetrics.identityKey(fields.map(field => row[field]));
    const history = Object.values(view.journal).flat().filter(match).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
    host.append(element('h3', 'Журнал наблюдений'));
    if (!history.length) { host.append(element('p', 'Зафиксированных наблюдений пока нет.')); return; }
    const grid = element('div', undefined, 'scroll history-scroll');
    table(grid, ['Отчётный месяц', 'Зафиксировано SPM', 'Событие', 'Статус', 'Дата по JSON', 'Источник', 'Версия'],
      history.flatMap(item => item.events.map(event => [item.month, fmt(item.observedAt), event.type, badge(event.status), fmt(event.actualAt),
        item.source === 'cloud' ? 'Облачный архив' : 'Ручной импорт', item.name + ' · SHA-256 ' + item.fingerprint])));
    host.append(grid);
  }
  byId('matrixWorkShift').onchange = event => drawDetail(detailRows.find(row => row.id === event.target.value));

  function drawTable() {
    const list = view.rows.map(row => ({
      row, values: [...fields.map(field => row[field]), row.work?.exportedAt || '', row.age,
        row.work?.rotation.formed || 'unknown', row.work?.rotation.approved || 'unknown', row.work?.development.formed || 'unknown']
    }));
    if (sort.index >= 0) list.sort(({ values: a }, { values: b }) => {
      const first = a[sort.index], second = b[sort.index];
      if (first == null || second == null) return Number(first == null) - Number(second == null);
      return sort.direction * (typeof first === 'number' ? first - second : String(first).localeCompare(String(second), 'ru'));
    });
    const host = byId('matrixWorkRows');
    const headers = [...labels, 'Последний экспорт', 'Возраст, дней', 'План ротации', 'Утверждение ротации',
      'План развития'];
    table(host, headers, list.map(({ row, values }) => values.map((value, i) => {
      if (i === 2) {
        const button = element('button', value, 'rating-section');
        button.onclick = () => showDetail(row);
        return button;
      }
      if (i === 4) return fmt(value);
      if (i >= 6) return badge(value);
      return value ?? '—';
    })));
    host.querySelectorAll('thead th').forEach((cell, index) => {
      const button = element('button', headers[index], 'rotation-sort');
      cell.replaceChildren(button);
      if (sort.index === index) cell.setAttribute('aria-sort', sort.direction > 0 ? 'ascending' : 'descending');
      button.onclick = () => {
        sort = { index, direction: sort.index === index ? -sort.direction : 1 };
        drawTable();
        host.querySelectorAll('th button')[index].focus();
      };
    });
  }

  function render(records, rosters, journal, month, plant, scope) {
    const expected = (rosters[month] ?? []).filter(scope);
    const rows = api.makeRows(records.filter(row => row.month === month), expected, journal, month);
    const observations = Object.values(journal).map(items => items.at(-1)).filter(row => row && scope(row));
    const removed = observations.filter(row => row.month === month && !rows.some(item => item.id === row.id))
      .map(row => ({ ...row, name: '', work: null, freshness: 'unknown', history: journal[row.id] }));
    view = { rows: [...rows, ...removed], journal, details: [...rows, ...removed] };
    const cards = [
      metrics[0].slice(1),
      ['Матрицы без свежих данных', row => row.freshness === 'older', row => row.freshness !== 'unknown'],
      ...['rotation','development'].flatMap((key, index) => {
        const name = index ? 'развития' : 'ротации';
        return [['Планы ' + name + ' не сформированы', row => row.work?.[key].formed === 'absent', row => known(row, key, 'formed')],
          ...(key === 'rotation' ? [['Планы ротации не утверждены', row => row.work?.rotation.approved === 'pending', row => known(row, 'rotation', 'approved')]] : [])];
      })
    ];
    renderCards(byId('matrixWorkCards'), true, cards.map(([label, test, available]) => {
      const { count, total, percent } = quantity(rows, test, available);
      return [label, count ?? '—', total ? pct(percent) + ' · из ' + total + ' ожидаемых' : 'Ожидаемый состав не задан'];
    }));
    const outOfRoster = expected.length ? rows.filter(row => !row.expected).length : 0;
    byId('matrixWorkNotice').textContent = (expected.length ? '' : 'Полнота не подтверждена. ')
      + (outOfRoster ? 'Вне реестра: ' + outOfRoster + '. ' : '')
      + 'Матриц с недостатком данных: ' + rows.filter(insufficient).length + '. Свежесть определяется месяцем экспорта по МСК; норматив просрочки не установлен. ILU не передаёт статус утверждения плана развития.';
    byId('matrixWorkPlantPanel').hidden = !plant;
    if (plant) {
      const departments = [...Map.groupBy(rows, row => spmMetrics.identityKey([row.department])).values()];
      const summary = (name, items) => [name,
        ...metrics.map(([, , test, available]) => pct(quantity(items, test, available).percent)),
        new Set(items.filter(issue).map(row => spmMetrics.identityKey([row.department, row.workshop, row.section]))).size,
        items.filter(insufficient).length];
      table(byId('matrixWorkPlant'), ['Департамент', ...metrics.map(([, label]) => label), 'Участков требуют внимания', 'Матриц с недостатком данных'],
        [summary('Весь завод', rows), ...departments.map(items => summary(items[0].department, items))]);
    }
    drawTable();
  }
  return { render };
})();
