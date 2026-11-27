'use strict';

const { aggregate } = spmMetrics;
const byId = id => document.getElementById(id);
const month = byId('month');
const department = byId('department');
const names = ['department', 'workshop', 'section', 'shift'];
const clean = value => value.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
const departmentPicker = spmDepartmentPicker(byId('deptField'), clean);
const parts = record => names.map(name => record[name]);
const key = record => JSON.stringify(parts(record).map(clean));
const now = new Date();
month.value = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
let data = { matrices: [], rosters: {} };
let plant = false;
let scoreSection = false;
const analysisTabs = [byId('operatorTab'), byId('postTab'), byId('meanTab'), byId('trainerTab'), byId('rotationTab'), byId('matrixWorkTab'), byId('ratingTab')];
const analysisMetrics = [
  [['Операторы 2L', 'ops2'], ['Доля 2L', 'opPercent2', '%'], ['Операторы 3L', 'ops3'], ['Доля 3L', 'opPercent3', '%']],
  [['Посты 2L', 'posts2'], ['Доля 2L', 'postPercent2', '%'], ['Посты 3L', 'posts3'], ['Доля 3L', 'postPercent3', '%']],
  [['Итог ILU 2L', 'total2', '%'], ['Итог ILU 3L', 'total3', '%']],
  [['Покрытие', 'coveragePercent', '%'], ['Обеспечено', 'covered'], ['Всего постов', 'total']]
];
const activeAnalysis = { department: 0, plant: 0 };

function updateAnalysisTabs() {
  const active = activeAnalysis[plant ? 'plant' : 'department'];
  analysisTabs.forEach((tab, index) => {
    const selected = active === index;
    if (tab.id === 'ratingTab') {
      tab.hidden = false;
      tab.textContent = plant ? 'Рейтинг департаментов' : 'Рейтинг участков';
    }
    tab.setAttribute('aria-selected', selected);
    tab.tabIndex = selected ? 0 : -1;
    byId(tab.getAttribute('aria-controls')).hidden = !selected;
  });
}

analysisTabs.forEach((tab, index) => {
  tab.onclick = () => {
    activeAnalysis[plant ? 'plant' : 'department'] = index;
    render();
  };
  tab.onkeydown = event => {
    const available = analysisTabs.filter(item => !item.hidden);
    const destinations = { ArrowLeft: (index + available.length - 1) % available.length,
      ArrowRight: (index + 1) % available.length, Home: 0, End: available.length - 1 };
    if (!Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    const next = available[destinations[event.key]];
    next.click();
    next.focus();
  };
});
let replacementTarget;
const deleteDialog = byId('deleteMatrixDialog');
let deleteSelection;
let busy = false;

function element(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}

function scope(record) { return plant || clean(record.department) === clean(department.value); }

function coverage(period, records) {
  const expected = (data.rosters[period] || []).filter(scope);
  const registered = new Set(expected.map(key));
  const present = new Set(records.map(key));
  const missing = expected.filter(row => !present.has(key(row)));
  const extra = records.filter(row => !registered.has(key(row)));
  const complete = expected.length > 0 && missing.length === 0 && extra.length === 0;
  const text = expected.length ? (complete ? 'Полная выборка' : 'Неполная выборка') + ' · ' +
    (expected.length - missing.length) + ' из ' + expected.length +
    (extra.length ? ' · вне перечня: ' + extra.length : '') :
    'Полнота не подтверждена · перечень не задан · загружено: ' + records.length;
  return { missing, extra, complete, text };
}

function table(host, headers, rows, classes = []) {
  host.replaceChildren();
  const grid = element('table');
  const head = grid.createTHead().insertRow();
  headers.forEach(label => head.append(element('th', label)));
  const body = grid.createTBody();
  rows.forEach((values, index) => {
    const row = body.insertRow();
    if (classes[index]) row.className = classes[index];
    values.forEach(value => {
      const cell = row.insertCell();
      if (value instanceof Node) cell.append(value);
      else cell.textContent = value;
    });
  });
  host.append(grid);
}

function monthlyHistory(scoped) {
  const recordsByMonth = Map.groupBy(scoped, row => row.month);
  const periods = [...new Set([...recordsByMonth.keys(), ...Object.keys(data.rosters)])].sort();
  return periods.map(period => {
    const records = recordsByMonth.get(period) || [];
    return { period, records, totals: aggregate(records), coverage: coverage(period, records) };
  });
}

function renderChart(host, history, metric, maximum, suffix, available, series = [2, 3]) {
  host.replaceChildren();
  if (!history.some(available)) {
    host.append(element('p', 'Нет данных для графика.', 'muted'));
    return;
  }
  const plot = element('div', undefined, 'plot');
  for (const item of history) {
    const pair = element('div', undefined, 'pair');
    const bars = element('div', undefined, 'bars');
    if (available(item)) for (const n of series) {
      const value = item.totals[metric + n];
      const bar = element('div', undefined, 'bar');
      bar.style.height = value / maximum * 100 + '%';
      bar.append(element('span', value + suffix));
      bar.title = item.period + (n ? ' · ' + n + 'L' : '') + ' · ' + value + suffix;
      bars.append(bar);
    }
    pair.append(bars, element('span', item.period + (item.coverage.complete ? '' : ' *')));
    pair.title = item.coverage.text;
    plot.append(pair);
  }
  host.append(plot);
}

const hasMatrices = item => item.records.length > 0;
const activeMonths = history => history.map(item => item.period === month.value ? 'current' : '');

function renderPercentHistory(chart, host, history, metric, fields) {
  renderChart(chart, history, metric, 100, '%', hasMatrices);
  if (!history.length) { host.replaceChildren(); return; }
  const headers = ['Месяц'];
  for (const n of [2, 3]) headers.push(n + 'L', 'Δ ' + n + 'L', ...fields.map(([label]) => label + ' ' + n + 'L'));
  headers.push('Полнота');
  table(host, headers, history.map((item, index) => {
    const cells = [item.period];
    const prior = history[index - 1];
    for (const n of [2, 3]) {
      const field = metric + n;
      const hasData = hasMatrices(item);
      const change = hasData && prior && hasMatrices(prior) ? item.totals[field] - prior.totals[field] : null;
      cells.push(hasData ? item.totals[field] + '%' : '—',
        change === null ? '—' : (change > 0 ? '+' : '') + change + ' п.п.');
      for (const [, value] of fields) cells.push(hasData ? value(item.totals, n) : '—');
    }
    return [...cells, item.coverage.text];
  }), activeMonths(history));
}

function renderCards(host, available, cards) {
  host.replaceChildren(...cards.map(([label, value, hint]) => {
    const card = element('article', undefined, 'card');
    card.append(element('div', label), element('strong', available ? value : '—'),
      element('small', available ? hint : 'Нет данных за выбранный месяц'));
    return card;
  }));
}

function hasPostCounts(item) {
  return hasMatrices(item) && item.records.every(({ counts }) =>
    ['posts', 'posts2', 'posts3'].every(field => Number.isSafeInteger(counts?.[field]) && counts[field] >= 0)
    && counts.posts3 <= counts.posts2 && counts.posts2 <= counts.posts);
}

function renderPosts(selected, totals, history) {
  const available = hasPostCounts({ records: selected });
  renderCards(byId('postCards'), available, [2, 3].map(n => [
    'Посты ' + n + 'L', totals['postPercent' + n] + '%', totals['posts' + n] + ' из ' + totals.posts + ' постов'
  ]));
  const validMonths = history.filter(hasPostCounts);
  const first = validMonths[0]?.period;
  byId('postHistoryStatus').textContent = first
    ? 'Данные по постам доступны с ' + first + '. * Полнота выборки не подтверждена или есть расхождения.'
    : 'Нет месячных срезов с данными по постам.';
  const maximum = validMonths.reduce((max, item) => Math.max(max, item.totals.posts2), 1);
  renderChart(byId('postCountChart'), history, 'posts', maximum, '', hasPostCounts);
  renderChart(byId('postRateChart'), history, 'postPercent', 100, '%', hasPostCounts);
  const host = byId('postHistory');
  if (!history.length) { host.replaceChildren(); return; }
  const headers = ['Месяц', 'Всего постов', 'Посты 2L', 'Доля 2L', 'Посты 3L', 'Доля 3L', 'Полнота'];
  table(host, headers, history.map(item => {
    const t = item.totals;
    const values = hasPostCounts(item) ? [t.posts, t.posts2, t.postPercent2 + '%', t.posts3, t.postPercent3 + '%']
      : ['—', '—', '—', '—', '—'];
    return [item.period, ...values, item.coverage.text];
  }), activeMonths(history));
}

function trainerUnavailable(records) {
  if (!records.length) return 'За месяц нет загруженных матриц.';
  if (records.some(record => !Array.isArray(record.trainerPosts))) return 'В исходных JSON не хватает данных о постах или квалификациях.';
  return 'Посты между сменами нельзя сопоставить однозначно.';
}

function renderTrainers(selected, history) {
  const result = spmTrainers.aggregate(selected);
  renderCards(byId('trainerCards'), result, [
    ['Покрытие форматорами', result?.coveragePercent + '%', result?.covered + ' из ' + result?.total + ' постов'],
    ['Посты без U', result?.uncovered.length, 'Всего учитывается постов: ' + result?.total]
  ]);
  const trainerHistory = history.map(item => ({ ...item, totals: spmTrainers.aggregate(item.records) }));
  const first = trainerHistory.find(item => item.totals)?.period;
  const note = first ? 'Данные по форматорам доступны с ' + first + '.' : 'Нет подтверждённых месячных данных по форматорам.';
  const incomplete = result ? '' : ' ' + trainerUnavailable(selected);
  byId('trainerHistoryStatus').textContent = note + incomplete;
  renderChart(byId('trainerChart'), trainerHistory, 'coveragePercent', 100, '%', item => item.totals !== null, ['']);
  const host = byId('trainerHistory');
  host.replaceChildren();
  if (trainerHistory.length) table(host, ['Месяц', 'Покрытие', 'Обеспечено', 'Всего постов', 'Без покрытия', 'Полнота'],
    trainerHistory.map(item => {
      const t = item.totals;
      return [item.period, t ? t.coveragePercent + '%' : '—', t?.covered ?? '—', t?.total ?? '—',
        t?.uncovered.length ?? '—', t ? item.coverage.text : trainerUnavailable(item.records) + ' ' + item.coverage.text];
    }), activeMonths(trainerHistory));
  const detail = byId('trainerUncovered');
  if (result?.uncovered.length) {
    table(detail, ['Департамент', 'Цех', 'Участок', 'Пост', 'Идентификатор'], result.uncovered.map(post => [
      post.department, post.workshop, post.section, post.name, post.id || '—'
    ]));
  } else {
    detail.replaceChildren(element('p', result ? 'На всех учитываемых постах есть U.' : 'Нет подтверждённого списка за месяц.', 'muted'));
  }
}

function render() {
  byId('deptTab').setAttribute('aria-pressed', !scoreSection && !plant);
  byId('plantTab').setAttribute('aria-pressed', !scoreSection && plant);
  byId('spmScoreTab').setAttribute('aria-pressed', scoreSection);
  byId('spmScoreView').hidden = !scoreSection;
  byId('spmScoreToolbar').hidden = !scoreSection;
  byId('workspaceToolbar').classList.toggle('filters--score', scoreSection);
  byId('analyticsView').hidden = scoreSection;
  const ratingVisible = activeAnalysis[plant ? 'plant' : 'department'] === analysisTabs.indexOf(byId('ratingTab'));
  byId('deptField').hidden = scoreSection || plant;
  byId('monthField').hidden = scoreSection || ratingVisible;
  byId('upload').hidden = scoreSection || plant || ratingVisible;
  byId('cloudOpen').hidden = scoreSection || plant || ratingVisible;
  byId('cloudConnection').hidden = scoreSection;
  if (scoreSection) {
    spmScoreUI.render(data);
    return;
  }

  updateAnalysisTabs();
  byId('plan').hidden = !plant || ratingVisible;
  const rotationVisible = activeAnalysis[plant ? 'plant' : 'department'] === analysisTabs.indexOf(byId('rotationTab'));
  const matrixWorkVisible = activeAnalysis[plant ? 'plant' : 'department'] === analysisTabs.indexOf(byId('matrixWorkTab'));
  for (const id of ['coverage', 'matrixRowsPanel']) byId(id).hidden = ratingVisible || rotationVisible || matrixWorkVisible;

  departmentPicker.update([...data.matrices.map(row => row.department),
    ...Object.values(data.rosters).flat().map(row => row.department)]);
  const scoped = data.matrices.filter(scope);
  const selected = scoped.filter(row => row.month === month.value);
  const t = aggregate(selected);
  byId('departmentPostCount').textContent = selected.length ? t.posts : '—';
  byId('departmentOperatorCount').textContent = selected.length ? t.operators : '—';
  const period = month.value ? 'За ' + month.value.split('-').reverse().join('.') + ' · ' : '';
  byId('departmentTotalsPeriod').textContent = period + (selected.length ? 'По загруженным матрицам' : 'Нет загруженных матриц');
  if (ratingVisible) {
    spmRatingUI.render(plant ? null : department.value, data);
    return;
  }
  if (matrixWorkVisible) {
    spmMatrixWorkUI.render(scoped, data.rosters, data.workJournal ?? {}, month.value, plant, scope);
    return;
  }
  if (rotationVisible) {
    spmRotationUI.render(scoped, data.rosters, month.value, plant, scope);
    return;
  }
  const completeness = coverage(month.value, selected);
  const banner = byId('coverage');
  banner.textContent = completeness.text + (!plant && !completeness.complete ? ' · перечень можно задать во вкладке «Завод»' : '');
  banner.classList.toggle('complete', completeness.complete);
  renderCards(byId('cards'), selected.length, [2, 3].map(n => [
    'Операторы ' + n + 'L', t['opPercent' + n] + '%', t['ops' + n] + ' из ' + t.operators + ' операторов'
  ]));
  renderCards(byId('meanCards'), selected.length, [2, 3].map(n => [
    'Итог ILU ' + n + 'L', t['total' + n] + '%', 'Посты ' + t['postPercent' + n] + '% · операторы ' + t['opPercent' + n] + '%'
  ]));
  const history = monthlyHistory(scoped);
  renderPercentHistory(byId('chart'), byId('history'), history, 'opPercent',
    [['Операторы', (totals, n) => totals['ops' + n] + ' из ' + totals.operators]]);
  renderPosts(selected, t, history);
  renderPercentHistory(byId('meanChart'), byId('meanHistory'), history, 'total', [
    ['Посты', (totals, n) => totals['postPercent' + n] + '%'],
    ['Операторы', (totals, n) => totals['opPercent' + n] + '%']
  ]);
  const active = activeAnalysis[plant ? 'plant' : 'department'];
  const trainersVisible = analysisTabs[active].id === 'trainerTab';
  if (trainersVisible) renderTrainers(selected, history);
  const metrics = analysisMetrics[active];
  const headings = metrics.map(([label]) => label);
  const values = totals => metrics.map(([, field, suffix = '']) => totals ? totals[field] + suffix : '—');
  byId('rowsTitle').textContent = plant ? 'Департаменты за месяц' : 'Загруженные матрицы';
  const rows = byId('rows');
  if (!selected.length) rows.replaceChildren(element('p', 'За выбранный месяц матриц пока нет.', 'muted'));
  else if (plant) {
    const groups = Map.groupBy(selected, row => clean(row.department));
    const population = trainersVisible ? [] : ['Постов', 'Операторов'];
    table(rows, ['Департамент', 'Матриц', ...population, ...headings],
      [...groups.values()].map(records => {
        const totals = aggregate(records);
        const counts = trainersVisible ? [] : [totals.posts, totals.operators];
        const summary = trainersVisible ? spmTrainers.aggregate(records) : totals;
        return [records[0].department, records.length, ...counts, ...values(summary)];
      }));
  } else {
    table(rows, ['Цех', 'Участок', 'Смена', 'JSON', ...headings, 'Действие'], selected.map(row => {
      const button = element('button', 'Заменить');
      button.disabled = busy;
      button.addEventListener('click', () => { replacementTarget = row; byId('replacement').click(); });
      const remove = element('button', 'Удалить', 'danger-button');
      remove.disabled = busy;
      remove.dataset.matrixId = row.id;
      remove.addEventListener('click', () => openDeleteMatrix(row));
      const actions = element('div', undefined, 'matrix-row-actions');
      actions.append(button, remove);
      const summary = trainersVisible ? spmTrainers.aggregate([row]) : row.metrics;
      return [row.workshop, row.section, row.shift, row.name, ...values(summary), actions];
    }));
  }
  const missing = byId('missing');
  missing.replaceChildren();
  if ((data.rosters[month.value] || []).length) {
    for (const [label, entries] of [['Ожидаются', completeness.missing], ['Вне перечня', completeness.extra]]) {
      if (!entries.length) continue;
      missing.append(element('p', label + ' (' + entries.length + ')'));
      const list = element('ul');
      list.append(...entries.map(entry => element('li', parts(entry).join(' · '))));
      missing.append(list);
    }
  }
}

const deleteMessages = {
  deleted: 'Матрица удалена из SPM Analysis.',
  missing: 'Матрица уже удалена.',
  changed: 'Матрица изменилась. Проверьте новую версию и повторите удаление.'
};

async function openDeleteMatrix(row) {
  if (busy || deleteDialog.open) return;
  const fields = [
    ['Департамент', row.department], ['Цех', row.workshop], ['Участок', row.section],
    ['Смена', row.shift], ['Месяц', row.month], ['Исходный JSON', row.name]
  ];
  byId('deleteMatrixDetails').replaceChildren(...fields.flatMap(([label, value]) =>
    [element('dt', label), element('dd', value)]));
  byId('deleteMatrixError').hidden = true;
  const selection = { row };
  deleteSelection = selection;
  const confirm = byId('confirmMatrixDelete');
  confirm.disabled = true;
  deleteDialog.showModal();
  try {
    const records = await spmStorage.ratingMatrices(row.month);
    if (deleteSelection !== selection || !deleteDialog.open) return;
    const current = records.find(record => record.id === row.id);
    if (!current || current.name !== row.name || current.importedAt !== row.importedAt) {
      const snapshot = await spmStorage.snapshot();
      if (deleteSelection !== selection || !deleteDialog.open) return;
      data = snapshot;
      render();
      deleteDialog.close();
      message(deleteMessages[current ? 'changed' : 'missing']);
      return;
    }
    selection.version = current;
    confirm.disabled = false;
  } catch (error) {
    if (deleteSelection === selection && deleteDialog.open) showDeleteError(error);
  }
}

function showDeleteError(error) {
  const notice = byId('deleteMatrixError');
  notice.textContent = 'Не удалось удалить матрицу. ' + error.message;
  notice.hidden = false;
}

byId('confirmMatrixDelete').onclick = async () => {
  if (busy || !deleteSelection?.version) return;
  const { row, version } = deleteSelection;
  const confirm = byId('confirmMatrixDelete');
  const cancel = byId('cancelMatrixDelete');
  confirm.disabled = true;
  cancel.disabled = true;
  byId('deleteMatrixError').hidden = true;
  setBusy(true);
  try {
    const result = await spmStorage.deleteMatrix(row.id, version);
    data = result.data;
    deleteDialog.close();
    message(deleteMessages[result.status]);
  } catch (error) {
    showDeleteError(error);
    confirm.disabled = false;
  } finally {
    cancel.disabled = false;
    setBusy(false);
  }
};
byId('cancelMatrixDelete').onclick = () => deleteDialog.close();
deleteDialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
deleteDialog.addEventListener('close', () => {
  const id = deleteSelection?.row.id;
  deleteSelection = undefined;
  const action = [...byId('rows').querySelectorAll('[data-matrix-id]')].find(button => button.dataset.matrixId === id);
  (action ?? byId('upload')).focus({ preventScroll: true });
});

function loadRoster() {
  byId('roster').value = (data.rosters[month.value] || []).map(row => parts(row).join('; ')).join('\n');
}
function message(text) { byId('message').textContent = text; }

async function upload(input, target) {
  const selected = [...input.files];
  input.value = '';
  if (!selected.length || busy) return;
  if (selected.length > 100) { message('Выберите до 100 файлов за одну операцию.'); return; }
  const period = target?.month || month.value;
  const dept = target?.department || department.value.trim();
  if (!period || !dept) { message('Выберите месяц и укажите департамент.'); return; }
  setBusy(true);
  message('Загрузка матриц…');
  try {
    data = await spmStorage.importFiles({ files: selected, month: period, department: dept, replaceId: target?.id, progress: message });
    const list = element('ul');
    list.append(...data.results.map(result => element('li', result.name + ' · ' + spmMatrixFiles.showSize(result.size) + ' · ' + result.status)));
    byId('message').replaceChildren(list);
  } catch (error) { message(error.message); }
  finally { setBusy(false); }
}

function openSection(section) {
  scoreSection = section === 'score';
  if (!scoreSection) plant = section === 'plant';
  message('');
  render();
}
byId('deptTab').onclick = () => openSection('department');
byId('plantTab').onclick = () => openSection('plant');
byId('spmScoreTab').onclick = () => openSection('score');
department.addEventListener('input', render);
month.onchange = () => { loadRoster(); message(''); render(); };
byId('upload').onclick = () => byId('batch').click();
byId('batch').onchange = event => upload(event.target);
byId('replacement').onchange = event => upload(event.target, replacementTarget);

function rosterLines() {
  return byId('roster').value.split(/\r?\n/).filter(line => line.trim()).map(line => line.split(';').map(value => value.trim()));
}
byId('appendLoaded').onclick = () => {
  const known = new Map(rosterLines().map(row => [JSON.stringify(row.map(clean)), row.join('; ')]));
  for (const row of data.matrices.filter(record => record.month === month.value)) {
    known.set(key(row), parts(row).join('; '));
  }
  byId('roster').value = [...known.values()].join('\n');
};
byId('copyRoster').onclick = () => {
  const previous = Object.keys(data.rosters).filter(period => period < month.value && data.rosters[period].length).sort().at(-1);
  if (!previous) { message('Предыдущий перечень не найден.'); return; }
  byId('roster').value = data.rosters[previous].map(row => parts(row).join('; ')).join('\n');
  message('Перечень скопирован из ' + previous + '. Проверьте состав и сохраните.');
};
byId('saveRoster').onclick = async () => {
  if (busy) return;
  setBusy(true);
  try {
    data = await spmStorage.saveRoster(month.value, rosterLines());
    loadRoster(); render(); message('Перечень сохранён.');
  } catch (error) { message(error.message); }
  finally { setBusy(false); }
};
function setBusy(value) {
  busy = value;
  for (const id of ['upload', 'cloudOpen', 'exportBackup', 'loadBackup', 'saveRoster']) byId(id).disabled = value;
  render();
}

byId('exportBackup').onclick = async () => {
  if (busy) return;
  setBusy(true);
  try {
    const raw = await spmStorage.exportBackup();
    const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
    const link = element('a');
    link.href = url;
    link.download = 'SPM-Analysis-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    message('Резервная копия передана в загрузки Edge.');
  } catch (error) { message('Не удалось создать копию. ' + error.message); }
  finally { setBusy(false); }
};

byId('loadBackup').onclick = () => byId('backupFile').click();
byId('backupFile').onchange = async event => {
  const [file] = event.target.files;
  event.target.value = '';
  if (!file || busy) return;
  setBusy(true);
  try {
    const state = spmStorage.validateBackup(await file.text());
    const count = Object.keys(state.matrices).length;
    if (!confirm('Матриц в копии: ' + count + '. Восстановление заменит все текущие матрицы и перечни. Продолжить?')) return;
    data = await spmStorage.restore(state);
    const latest = data.matrices.map(row => row.month).sort().at(-1);
    if (latest) month.value = latest;
    const example = data.matrices.find(row => row.month === latest && scope(row)) ??
      data.matrices.find(row => row.month === latest);
    if (example) department.value = example.department;
    loadRoster();
    message('Резервная копия восстановлена. Матриц: ' + count + '.');
  } catch (error) { message('Не удалось восстановить копию. ' + error.message); }
  finally { setBusy(false); }
};

setBusy(true);
spmStorage.start().then(result => {
  data = result.data;
  const status = byId('storageStatus');
  status.textContent = result.persistent
    ? 'Хранилище Edge доступно. Скачивайте резервную копию после изменений и перед переносом приложения.'
    : 'Хранилище Edge недоступно. Изменения сохраняются только в открытой вкладке. Скачайте копию до её закрытия.';
  if (!result.persistent) {
    status.className = 'coverage';
    status.closest('details').open = true;
  }
  const latest = data.matrices.map(row => row.month).sort().at(-1);
  if (latest) {
    month.value = latest;
    const first = data.matrices.find(row => row.month === latest && scope(row)) ??
      data.matrices.find(row => row.month === latest);
    department.value = first.department;
  }
  loadRoster();
  setBusy(false);
});
