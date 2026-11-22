'use strict';

globalThis.spmRatingUI = (() => {
  const metricTabs = byId('ratingMetrics');
  const boards = byId('ratingBoards');
  const status = byId('ratingStatus');
  const periods = byId('ratingPeriods');
  const dialog = byId('ratingDetail');
  const periodFormat = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  let report;
  let request;
  let activeMetric = 0;
  const tabs = spmRating.indicators.map(([key, label], index) => {
    const tab = element('button', key === 'coveragePercent' ? 'Форматоры (U)' : label);
    tab.type = 'button';
    tab.id = 'rating-metric-' + key;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'ratingBoards');
    tab.onclick = () => selectMetric(index);
    tab.onkeydown = event => {
      const destinations = {
        ArrowLeft: (index + tabs.length - 1) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1
      };
      if (!Object.hasOwn(destinations, event.key)) return;
      event.preventDefault();
      const next = destinations[event.key];
      selectMetric(next);
      tabs[next].focus();
    };
    return tab;
  });
  metricTabs.replaceChildren(...tabs);
  selectMetric(0);

  function selectMetric(index) {
    activeMetric = index;
    tabs.forEach((tab, position) => {
      const selected = position === index;
      tab.setAttribute('aria-selected', selected);
      tab.tabIndex = selected ? 0 : -1;
    });
    boards.setAttribute('aria-labelledby', tabs[index].id);
    if (report) draw();
  }

  function periodDate(month) {
    return new Date(month + '-01T00:00:00Z');
  }

  function previousMonth(month) {
    const date = periodDate(month);
    date.setUTCMonth(date.getUTCMonth() - 1);
    return date.toISOString().slice(0, 7);
  }

  function monthName(month) {
    return periodFormat.format(periodDate(month));
  }

  function formatMetadata(section) {
    if (!report.wholeDepartment) return section.matrices.length + ' матриц · смен учтено: ' + section.shifts + ' · ' + section.completeness;
    return 'Матриц: ' + section.matrices.length + ' · участков: ' + section.sections + ' · смен: ' + section.shifts + ' · ' + section.completeness;
  }

  function matrixLabel(record) {
    return report.wholeDepartment ? record.workshop + ' / ' + record.section + ' · Смена ' + record.shift : record.shift;
  }

  function openSection(row) {
    byId('ratingDetailTitle').textContent = row.section;
    const content = byId('ratingDetailContent');
    const [key, label] = spmRating.indicators[activeMetric];
    const previous = row.previous?.metrics[key];
    const current = row.current?.metrics[key];
    const change = previous === undefined || current === undefined ? null : current - previous;
    content.replaceChildren();
    if (!report.wholeDepartment) content.append(element('p', row.department + ' · ' + row.workshop));
    content.append(element('p', label + ' · изменение: ' + (change === null ? '—' : (change > 0 ? '+' : '') + change + ' п.п.')));
    for (const side of ['previous', 'current']) {
      const period = report[side];
      const section = row[side];
      content.append(element('h3', monthName(period.month)));
      const value = section?.metrics[key];
      content.append(element('p', 'Результат: ' + (value === undefined ? '—' : value + '%')));
      if (!section) {
        const expected = period.expected.filter(record => spmMetrics.identityKey(report.wholeDepartment ? [record.department] : [record.department, record.workshop, record.section]) === row.id);
        content.append(element('p', 'Нет загруженных матриц.'));
        if (expected.length) content.append(element('p', 'Ожидаются смены — ' + expected.map(matrixLabel).join(', ')));
        continue;
      }
      content.append(element('p', formatMetadata(section)));
      for (const [label, records] of [['Ожидаются смены', section.missing], ['Вне перечня', section.extra]]) {
        if (records.length && section.expected.length) content.append(element('p', label + ' — ' + records.map(matrixLabel).join(', ')));
      }
      for (const warning of section.warnings) content.append(element('p', warning, 'coverage'));
      const list = element('ul', undefined, 'rating-files');
      for (const record of section.matrices) {
        const item = element('li');
        const button = element('button', 'Скачать JSON');
        button.onclick = () => {
          const url = URL.createObjectURL(new Blob([record.raw], { type: 'application/json' }));
          const link = element('a');
          link.href = url;
          link.download = record.name || 'matrix.json';
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
        };
        item.append(element('span', (report.wholeDepartment ? matrixLabel(record) : 'Смена ' + record.shift) + ' · ' + record.name), button);
        list.append(item);
      }
      content.append(list);
    }
    dialog.showModal();
  }

  function reportPeriod(month, records, expected, wholeDepartment) {
    const sections = spmRating.build(records, expected, month, wholeDepartment);
    const loaded = new Set(records.map(record => record.id));
    const found = expected.filter(record => loaded.has(spmMetrics.recordKey(month, record))).length;
    const extra = expected.length ? loaded.size - found : 0;
    const complete = expected.length > 0 && found === expected.length && extra === 0;
    const text = !records.length ? 'Нет загруженных матриц' + (expected.length ? ' · 0 из ' + expected.length + ' матриц по перечню' : '')
      : !expected.length ? 'Полнота не подтверждена · перечень не задан'
        : (complete ? 'Полная выборка' : 'Неполная выборка') + ' · ' + found + ' из ' + expected.length + ' матриц по перечню'
          + (extra ? ' · вне перечня: ' + extra : '');
    return { month, sections, text, expected };
  }

  function bar(side, value) {
    const month = monthName(report[side].month);
    const row = element('div', undefined, 'rating-bar rating-' + side);
    row.setAttribute('role', 'img');
    row.setAttribute('aria-label', month + ': ' + (value === undefined ? 'нет данных' : value + '%'));
    const label = element('span', value === undefined ? '—' : value + '%', 'rating-value');
    if (value !== undefined) {
      row.style.setProperty('--rating-value', value + '%');
      row.append(element('span', undefined, 'rating-fill'));
    }
    row.append(label);
    return row;
  }

  function draw() {
    const [key, label] = spmRating.indicators[activeMetric];
    const panel = element('figure', undefined, 'panel rating-board');
    if (report.wholeDepartment) panel.classList.add('rating-board--departments');
    const caption = element('figcaption', label);
    const legend = element('div', undefined, 'rating-legend');
    for (const side of ['previous', 'current']) {
      legend.append(element('span', monthName(report[side].month), 'rating-' + side));
    }
    const chart = element('div', undefined, 'rating-chart');
    chart.tabIndex = 0;
    chart.setAttribute('role', 'region');
    chart.setAttribute('aria-label', label + ' · сравнительная диаграмма');
    const sheet = element('div', undefined, 'rating-sheet');
    const grid = element('div', undefined, 'rating-gridlines');
    grid.setAttribute('aria-hidden', 'true');
    const header = element('div', undefined, 'rating-header');
    const axis = element('div', undefined, 'rating-axis');
    for (const value of [0, 25, 50, 75, 100]) {
      const tick = element('span', value + '%');
      tick.style.left = value + '%';
      axis.append(tick);
    }
    header.append(element('span', report.wholeDepartment ? 'Департамент' : 'Участок'), axis, element('span', 'Изменение', 'rating-delta'));
    const list = element('ol', undefined, 'rating-list');
    spmRating.rank(report.rows, key).forEach((section, index) => {
      const previous = section.previous?.metrics[key];
      const current = section.current?.metrics[key];
      const row = element('li', undefined, 'rating-entry');
      const name = element('button', section.section, 'rating-section');
      name.onclick = () => openSection(section);
      const details = element('div', undefined, 'rating-label');
      const names = element('div');
      names.append(name);
      if (!report.wholeDepartment) names.append(element('small', section.workshop, 'rating-meta'));
      details.append(element('span', current === undefined ? '—' : String(index + 1), 'rating-place'), names);
      const plot = element('div', undefined, 'rating-plot');
      plot.append(bar('previous', previous), bar('current', current));
      const difference = current === undefined || previous === undefined ? null : current - previous;
      const delta = element('strong', difference === null ? '—' : (difference > 0 ? '+' : '') + difference + ' п.п.', 'rating-delta');
      if (difference > 0) delta.classList.add('rating-gain');
      if (difference < 0) delta.classList.add('rating-loss');
      delta.setAttribute('aria-label', difference === null ? 'Изменение недоступно' : 'Изменение: ' + delta.textContent);
      row.append(details, plot, delta);
      list.append(row);
    });
    sheet.append(grid, header, list);
    chart.append(sheet);
    panel.append(caption, legend, chart);
    boards.replaceChildren(panel);
  }

  function render(department, data) {
    const wholeDepartment = department === null;
    const departmentKey = wholeDepartment ? null : spmMetrics.identityKey([department]);
    if (request?.departmentKey === departmentKey && request.data === data) return;
    const currentRequest = { departmentKey, data };
    request = currentRequest;
    report = undefined;
    boards.replaceChildren();
    periods.replaceChildren();
    byId('ratingTitle').textContent = wholeDepartment ? 'Рейтинг департаментов' : 'Рейтинг участков';
    const inScope = record => wholeDepartment || spmMetrics.identityKey([record.department]) === departmentKey;
    const month = data.matrices.filter(inScope).map(record => record.month).sort().at(-1);
    if (!month) {
      status.textContent = wholeDepartment ? 'Нет загруженных матриц.'
        : department.trim() ? 'Для выбранного департамента нет загруженных матриц.' : 'Выберите департамент.';
      return;
    }
    const previous = previousMonth(month);
    status.textContent = 'Загрузка рейтинга…';
    Promise.all([previous, month].map(async period => {
      const records = (await spmStorage.ratingMatrices(period)).filter(inScope);
      return reportPeriod(period, records, (data.rosters[period] ?? []).filter(inScope), wholeDepartment);
    })).then(([previous, current]) => {
      if (request !== currentRequest) return;
      const rows = new Map();
      for (const [side, result] of [['previous', previous], ['current', current]]) {
        for (const section of result.sections) {
          if (!rows.has(section.id)) rows.set(section.id, { ...section, metrics: {} });
          const row = rows.get(section.id);
          row[side] = section;
          if (side === 'current') {
            row.metrics = section.metrics;
            row.section = section.section;
          }
        }
      }
      report = { wholeDepartment, previous, current, rows: [...rows.values()] };
      for (const [side, result] of [['previous', previous], ['current', current]]) {
        const block = element('div', undefined, 'rating-period-label rating-' + side);
        block.append(element('strong', monthName(result.month)), element('small', result.text, 'rating-meta'));
        periods.append(block);
      }
      status.textContent = previous.sections.length
        ? (wholeDepartment ? 'Департаментов в сравнении: ' : 'Участков в сравнении: ') + rows.size
        : 'За предыдущий месяц нет данных. Показатели текущего месяца доступны без сравнения.';
      draw();
    }).catch(error => {
      if (request === currentRequest) status.textContent = 'Не удалось построить рейтинг. ' + error.message;
    });
  }

  return { render };
})();
