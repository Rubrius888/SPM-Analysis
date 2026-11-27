'use strict';

globalThis.spmRotationUI = (() => {
  const { summarize, status, previous, ratio } = spmRotation;
  const indicators = ['rotationCoverage', 'rotationExecution', 'rotationApproval'];
  const titles = ['Ротируемые операторы', 'Выполнение плана ротации', 'Утверждённые планы'];
  const formatted = value => typeof value === 'number' ? value.toLocaleString('ru-RU', { maximumFractionDigits: 1 }) + '%' : '—';
  const count = value => value ?? '—';
  let view;
  let sort = { index: -1, direction: 1 };
  const filters = {};
  const statusNode = key => element('span', status[key], 'rotation-status rotation-' + key);
  const fieldNames = { workshop: 'Цех', section: 'Участок', shift: 'Смена', status: 'Статус плана' };

  function detail(row) {
    const r = row.rotation;
    const eligible = r.people?.eligible.length;
    const rotated = r.people?.rotated.length;
    const planned = r.cells?.length;
    const executed = r.cells?.filter(cell => cell.fact).length;
    const approvedAt = Date.parse(r.approvedAt);
    return [row.workshop, row.section, row.shift, eligible, rotated, ratio(rotated, eligible), planned, executed,
      ratio(executed, planned), r.status, Number.isFinite(approvedAt) ? new Date(approvedAt).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' }) : '—'];
  }

  function drawTable() {
    const host = byId('rotationRows');
    const { current, expected, period, plant } = view;
    let headers, rows;
    if (plant) {
      const key = row => spmMetrics.identityKey([row.department]);
      const departments = Map.groupBy(current.rows, key);
      const rosters = Map.groupBy(expected, key);
      rows = [...departments].map(([key, items]) => {
        const a = summarize(items.filter(item => item.month), rosters.get(key) || [], period);
        return [items[0].department, a.eligible, a.rotated, a.rotationCoverage, a.planned, a.executed, a.rotationExecution,
          a.counts.approved, a.counts.pending, a.counts.absent, a.counts.unknown, a.rotationApproval, a.expected || null];
      });
      headers = ['Департамент', 'Операторов', 'Ротировано', 'Охват', 'План', 'Выполнено', 'Выполнение',
        'Утверждены', 'Не утверждены', 'Не сформированы', 'Нет данных', 'Утверждение', 'Ожидается'];
    } else {
      rows = current.rows.filter(row => Object.entries(filters).every(([key, value]) => !value ||
        (key === 'status' ? (value === 'attention' ? ['pending', 'absent'].includes(row.rotation.status) : row.rotation.status === value)
          : row[key] === value))).map(detail);
      headers = ['Цех', 'Участок', 'Смена', 'Операторов', 'Ротировано', 'Охват', 'План', 'Выполнено', 'Выполнение', 'Статус плана', 'Дата утверждения'];
    }
    const sorted = rows.toSorted((a, b) => {
      const first = a[sort.index], second = b[sort.index];
      if (first == null || second == null) return Number(first == null) - Number(second == null);
      return sort.direction * (typeof first === 'number' ? first - second : String(first).localeCompare(String(second), 'ru'));
    });
    const percentages = plant ? [3, 6, 11] : [5, 8];
    table(host, headers, sorted.map(row => row.map((value, index) => percentages.includes(index) ? formatted(value)
      : !plant && index === 9 ? statusNode(value) : count(value))));
    host.querySelectorAll('thead th').forEach((cell, index) => {
      const button = element('button', headers[index], 'rotation-sort');
      cell.replaceChildren(button);
      if (sort.index === index) cell.setAttribute('aria-sort', sort.direction > 0 ? 'ascending' : 'descending');
      button.onclick = () => {
        sort = { index, direction: sort.index === index ? -sort.direction : 1 };
        drawTable();
        host.querySelectorAll('thead button')[index].focus();
      };
    });
  }

  function drawFilters() {
    const host = byId('rotationFilters');
    host.replaceChildren();
    host.hidden = view.plant;
    if (view.plant) return;
    for (const [key, label] of Object.entries(fieldNames)) {
      const choices = key === 'status' ? [['attention', 'Не утверждены или не сформированы'], ...Object.entries(status)]
        : [...new Set(view.current.rows.map(row => row[key]))].sort((a, b) => a.localeCompare(b, 'ru')).map(value => [value, value]);
      const select = element('select');
      select.append(new Option('Все', ''), ...choices.map(([value, label]) => new Option(label, value)));
      select.value = choices.some(([value]) => value === filters[key]) ? filters[key] : '';
      filters[key] = select.value;
      select.onchange = () => { filters[key] = select.value; drawTable(); };
      const field = element('label', label);
      field.append(select);
      host.append(field);
    }
  }

  function drawHistory() {
    const field = byId('rotationChartMetric').value;
    const history = view.history.map(({ period, totals }) => ({ period, totals: { ...totals, [field]: totals[field] === null ? null : Number(totals[field].toFixed(1)) }, coverage: { complete: true } }));
    renderChart(byId('rotationChart'), history, field, 100, '%', item => item.totals[field] !== null, ['']);
    table(byId('rotationHistory'), ['Месяц', ...titles], history.map(item => [item.period, ...indicators.map(key => formatted(item.totals[key]))]));
  }

  function render(records, rosters, period, plant, scope) {
    if (view?.plant !== plant) sort = { index: -1, direction: 1 };
    const grouped = Map.groupBy(records, row => row.month);
    const months = [...new Set([...grouped.keys(), ...Object.keys(rosters).filter(key => rosters[key].some(scope)), ...(period ? [period] : [])])].sort();
    const forMonth = value => summarize(grouped.get(value) || [], (rosters[value] || []).filter(scope), value);
    const expected = (rosters[period] || []).filter(scope);
    const current = forMonth(period);
    const prior = forMonth(previous(period));
    view = { current, expected, period, plant, history: months.map(period => ({ period, totals: forMonth(period) })) };
    const delta = key => {
      if (current[key] === null || prior[key] === null) return 'Δ —';
      const diff = Number((current[key] - prior[key]).toFixed(1));
      return 'Δ ' + (diff > 0 ? '+' : '') + diff.toLocaleString('ru-RU') + ' п.п.';
    };
    const hints = [
      count(current.rotated) + ' из ' + count(current.eligible) + ' операторов · ' + delta(indicators[0]),
      count(current.executed) + ' из ' + count(current.planned) + ' назначений · ' + delta(indicators[1]),
      current.counts.approved + ' из ' + (current.expected || '—') + ' ожидаемых · не утверждены: ' + current.counts.pending
        + ' · не сформированы: ' + current.counts.absent + ' · нет данных: ' + current.counts.unknown
    ];
    renderCards(byId('rotationCards'), true, indicators.map((key, index) => [titles[index], formatted(current[key]), hints[index]]));
    const incomplete = current.rows.some(row => !row.rotation.people || (row.rotation.status === 'approved' && !row.rotation.cells));
    byId('rotationNotice').textContent = (!current.expected ? 'Полнота не подтверждена · перечень не задан. '
      : incomplete || current.counts.unknown ? 'Статистика неполная. ' : '')
      + (current.ambiguous ? 'Есть совпадения имён без достоверной идентификации операторов. ' : '')
      + (current.ambiguousCells ? 'Плановые назначения нельзя однозначно сопоставить между сменами. ' : '')
      + 'Охват включает подтверждённые назначения сформированных планов. Выполнение считается по утверждённым планам.';
    drawFilters();
    drawTable();
    drawHistory();
  }
  byId('rotationChartMetric').onchange = () => { if (view) drawHistory(); };
  return { render };
})();
