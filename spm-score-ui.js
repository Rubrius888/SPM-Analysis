'use strict';

globalThis.spmScoreUI = (() => {
  const monthField = byId('spmScoreMonth');
  const revision = byId('spmScoreRevision');
  const status = byId('spmScoreStatus');
  const saveButton = byId('spmScoreSave');
  const recalculate = byId('spmScoreRecalculate');
  const reasonDialog = byId('spmScoreReason');
  const reasonText = byId('spmScoreReasonText');
  const confirm = byId('spmScoreConfirm');
  const leaders = byId('spmScoreLeaders');
  const standings = byId('spmScoreStandings');
  const podium = byId('spmScorePodium');
  const tableHeading = byId('spmScoreTableHeading');
  const grid = byId('spmScoreTable');
  const detail = byId('spmScoreDetail');
  const points = new Intl.NumberFormat('ru', { maximumFractionDigits: 4 });
  const totals = new Intl.NumberFormat('ru', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const totalText = value => value === null ? '—' : totals.format(value);
  function weightText(value) {
    const ending = value % 10;
    const teens = value % 100 >= 11 && value % 100 <= 14;
    const unit = !Number.isInteger(value) || (!teens && ending >= 2 && ending <= 4) ? 'балла'
      : !teens && ending === 1 ? 'балл' : 'баллов';
    return amount(value) + ' ' + unit;
  }
  const time = new Intl.DateTimeFormat('ru', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Moscow' });
  const amount = (value, suffix = '') => value === null ? '—' : points.format(value) + suffix;
  let report, lastData, request = 0, saving = false, expectedRevision;

  const helpDialog = byId('spmScoreHelp');
  const helpExplanations = [
    '2L и 3L — пороги по числу постов на оператора или операторов на посту с уровнем L или U. Роли НУ, ДС и СО исключаются. Для покрытия форматорами достаточно одного U на посту в любой смене, независимо от роли.',
    'Охват — доля учитываемых операторов, у которых подтверждено хотя бы одно плановое назначение. Выполнение — доля подтверждённых назначений в утверждённом плане. Сверка с журналом фактов идёт по дате, посту и оператору.',
    'Для каждого статуса отдельно берётся доля ожидаемых смен участка, где статус подтверждён. Без перечня смен или при отсутствии известных статусов процент недоступен.'
  ];
  byId('spmScoreHelpWeights').replaceChildren(...spmScore.score({}).parts.map(({ label, weight, indicators }, index) => {
    const block = element('section', undefined, 'score-help-direction');
    const title = element('h3', label);
    title.append(element('span', weightText(weight)));
    const list = element('dl', undefined, 'score-help-indicators');
    for (const { name, weight } of indicators) {
      const line = element('div');
      line.append(element('dt', name), element('dd', weightText(weight)));
      list.append(line);
    }
    block.append(title, list, element('p', helpExplanations[index], 'score-help-description'));
    return block;
  }));
  byId('spmScoreHelpMaximum').textContent = weightText(spmScore.maximum);
  byId('spmScoreHelpOpen').onclick = () => helpDialog.showModal();
  helpDialog.addEventListener('click', event => {
    if (event.target !== helpDialog) return;
    const { left, top, right, bottom } = helpDialog.getBoundingClientRect();
    if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) helpDialog.close();
  });

  function delta(value) {
    const css = value > 0 ? 'rating-gain' : value < 0 ? 'rating-loss' : 'muted';
    return element('span', value === null ? '—' : (value > 0 ? '+' : value < 0 ? '−' : '') + points.format(Math.abs(value)), css);
  }

  function coverage(row) {
    if (!row.expectedIds.length) return row.completeness + ' · загружено: ' + row.versions.length;
    return row.completeness + ' · ' + (row.expectedIds.length - row.missing) + ' из ' + row.expectedIds.length
      + (row.extra ? ' · вне перечня: ' + row.extra : '');
  }

  function showBreakdown(host, parts) {
    for (const part of parts) {
      const block = element('section', undefined, 'score-detail-part');
      const indicators = element('div', undefined, 'scroll');
      table(indicators, ['Показатель', 'Вес', 'Значение', 'Баллы', 'Источник', 'Статус', 'Причина нулевого начисления'],
        part.indicators.map(item => [item.name, amount(item.weight), amount(item.percent, '%'), totalText(item.points), item.source, item.status, item.reason || '—']));
      block.append(element('h3', part.label + ' · ' + totalText(part.points) + ' из ' + amount(part.weight)), indicators);
      host.append(block);
    }
  }

  function openDetail(row, snapshot) {
    byId('spmScoreDetailTitle').textContent = row.section;
    const host = byId('spmScoreDetailContent');
    const archived = snapshot.methodology !== spmScore.version;
    const calculation = archived ? spmScore.score(Object.fromEntries(row.parts.flatMap(part =>
      part.indicators.map(item => [item.key, { value: item.percent, reason: item.reason }])))) : row;
    host.replaceChildren(element('p', row.department + ' · ' + (row.workshop || 'Цех не определён')),
      element('p', 'Месяц: ' + snapshot.month + ' · методика ' + spmScore.version),
      element('p', coverage(row), 'muted'));
    if (archived) {
      host.append(element('p', 'По действующей методике: ' + totalText(calculation.total) + ' из ' + spmScore.maximum + ' баллов'),
        element('p', 'Расчёт по процентам сохранённого снимка.', 'muted'));
    }
    if (calculation.preliminary) host.append(element('p', 'Предварительный рейтинг', 'muted'));
    const saved = element('p', 'Баллы из ' + snapshot.maximum + ': ' + totalText(row.previousScore)
      + ' → ' + totalText(row.total) + ' · места: ' + amount(row.previousPlace) + ' → ' + row.place);
    const summary = archived ? element('details', undefined, 'panel') : host;
    if (archived) summary.append(element('summary', 'Сохранённый снимок · методика ' + snapshot.methodology
      + ' · ' + totalText(row.total) + ' из ' + snapshot.maximum + ' · место ' + row.place));
    summary.append(saved);
    if (row.scoreChange !== null) {
      const changes = element('p', 'Изменение баллов: ');
      changes.append(delta(row.scoreChange), ' · изменение позиции: ', delta(row.placeChange));
      summary.append(changes);
    }
    showBreakdown(host, calculation.parts);
    if (archived) {
      showBreakdown(summary, spmScore.visibleParts(row));
      host.append(summary);
    }
    const sources = element('div', undefined, 'scroll score-source-list');
    if (row.versions.length) table(sources, ['Исходная матрица', 'Импорт (МСК)', 'SHA-256'],
      row.versions.map(item => [item.name, Number.isFinite(Date.parse(item.importedAt)) ? time.format(new Date(item.importedAt)) : '—', item.fingerprint]));
    else sources.append(element('p', 'За месяц не загружены матрицы участка.', 'muted'));
    host.append(element('h3', 'Версии исходных матриц'), sources);
    detail.showModal();
  }

  function siteButton(row, snapshot) {
    const button = element('button', row.section, 'rating-section');
    button.type = 'button';
    button.onclick = () => openDetail(row, snapshot);
    return button;
  }

  const medals = ['gold', 'silver', 'bronze'];

  function drawPodium(rows, snapshot) {
    const groups = Map.groupBy(rows, row => row.place);
    podium.replaceChildren(...[...groups].map(([place, winners]) => {
      const medal = medals[place - 1];
      const group = element('div', undefined, 'score-podium-group score-podium-' + medal);
      for (const row of winners) {
        const card = element('article', undefined, 'score-medalist');
        const heading = element('div', undefined, 'score-medalist-heading');
        const icon = element('img', undefined, 'score-medal-icon');
        icon.src = 'medal-' + medal + '.svg';
        icon.alt = '';
        icon.width = icon.height = 72;
        heading.append(icon, element('span', place + '-е место', 'score-medal-place'));
        if (winners.length > 1) heading.append(element('span', 'Разделено', 'score-medal-tie'));

        const identity = element('div', undefined, 'score-medalist-identity');
        const title = element('h3');
        title.append(siteButton(row, snapshot));
        identity.append(title, element('p', row.department + ' · ' + (row.workshop || 'Цех не определён'), 'score-medalist-meta'));
        const score = element('p', undefined, 'score-medalist-total');
        score.append(element('strong', totalText(row.total)), element('span', 'из ' + snapshot.maximum + ' баллов'));
        const progress = element('meter', undefined, 'score-medalist-progress');
        progress.min = 0;
        progress.max = snapshot.maximum;
        progress.value = row.total;
        progress.setAttribute('aria-label', 'Баллы участка');

        card.append(heading, identity, score, progress);
        group.append(card);
      }
      return group;
    }));
  }

  function drawStandings(rows, snapshot) {
    const list = element('ol', undefined, 'score-standings');
    list.setAttribute('role', 'list');
    for (const row of rows) {
      const item = element('li', undefined, 'score-standings-row');
      const place = element('span', String(row.place), 'rating-place score-table-place');
      place.setAttribute('aria-label', 'Место: ' + row.place);
      const name = element('div', undefined, 'score-standings-name');
      name.append(siteButton(row, snapshot), element('span', row.department + ' · ' + (row.workshop || 'Цех не определён'), 'score-standings-location'));
      const bar = element('meter', undefined, 'score-standings-meter');
      bar.min = 0;
      bar.max = snapshot.maximum;
      bar.value = row.total;
      bar.setAttribute('aria-label', 'Баллы участка');
      const score = element('span', totalText(row.total), 'score-standings-value');
      score.append(element('small', ' / ' + snapshot.maximum));
      item.append(place, name, bar, score);
      list.append(item);
    }
    grid.replaceChildren(list);
  }

  function draw() {
    const selected = report.revisions.find(item => item.id === revision.value) ?? report.revisions.at(-1) ?? report.preview;
    const latest = report.revisions.at(-1);
    const former = report.previous;
    const rows = spmScore.compare(selected, former);
    const archived = selected.methodology !== spmScore.version;
    const snapshot = { ...selected, maximum: selected.maximum ?? 100 };
    byId('spmScoreScale').textContent = 'Все участки завода' + (archived ? ' · архивная методика' : '')
      + ' · шкала 0–' + snapshot.maximum + ' баллов';
    const ratingStatus = preliminary => archived ? 'Архивный снимок' : preliminary ? 'Предварительный рейтинг' : 'Рейтинг';
    const period = label => label.slice(5) + '.' + label.slice(0, 4);
    byId('spmScorePrintPeriod').textContent = 'Отчётный месяц · ' + period(selected.month);
    saveButton.hidden = !!latest;
    saveButton.disabled = saving || !rows.length;
    recalculate.hidden = !latest;
    recalculate.disabled = saving;
    status.textContent = ratingStatus(selected.preliminary) + ' · методика ' + selected.methodology + ' · '
      + (selected.id ? 'снимок ' + time.format(new Date(selected.formedAt)) + ' МСК'
        + (selected.reason ? ' · причина пересчёта: ' + selected.reason : '') : 'предпросмотр, снимок ещё не сохранён')
      + (!former ? ' · нет сохранённого снимка за ' + period(spmScore.previousMonth(report.month))
        : former.methodology !== selected.methodology ? ' · динамика за ' + period(former.month)
          + ' недоступна: разные версии методики (' + selected.methodology + ' и ' + former.methodology + ')'
          : ' · сравнение со снимком за ' + period(former.month) + ', версия ' + former.revision);
    const winners = rows.filter(row => row.place <= medals.length);
    const remainder = rows.filter(row => row.place > medals.length);
    leaders.hidden = !winners.length;
    drawPodium(winners, snapshot);
    tableHeading.hidden = !remainder.length;
    standings.hidden = rows.length > 0 && !remainder.length;
    if (!rows.length || !remainder.length) {
      grid.replaceChildren(...(!rows.length ? [element('p', 'За месяц нет загруженных матриц и перечня ожидаемых смен.', 'muted')] : []));
      return;
    }
    drawStandings(remainder, snapshot);
  }

  async function load() {
    const id = ++request;
    report = undefined;
    status.textContent = 'Подготовка рейтинга…';
    leaders.hidden = tableHeading.hidden = standings.hidden = true;
    saveButton.disabled = recalculate.disabled = revision.disabled = true;
    podium.replaceChildren();
    grid.replaceChildren();
    try {
      const result = await spmStorage.scorePeriod(monthField.value);
      if (id !== request) return;
      report = result;
      monthField.value = result.month;
      byId('spmScoreRevisionField').hidden = !result.revisions.length;
      revision.replaceChildren(...result.revisions.toReversed().map(item =>
        new Option('Версия ' + item.revision + ' · методика ' + item.methodology + ' · ' + time.format(new Date(item.formedAt)) + ' МСК', item.id)));
      revision.disabled = saving;
      draw();
    } catch (error) {
      if (id === request) status.textContent = 'Не удалось открыть раздел «ILU рейтинг». ' + error.message;
    }
  }

  async function save(expectedId, reason = '') {
    if (saving || !report) return;
    saving = true;
    saveButton.disabled = recalculate.disabled = monthField.disabled = revision.disabled = confirm.disabled = true;
    try {
      await spmStorage.saveScore(report.month, expectedId, reason);
      if (reasonDialog.open) reasonDialog.close();
      saving = false;
      await load();
    } catch (error) {
      byId(reasonDialog.open ? 'spmScoreReasonStatus' : 'spmScoreStatus').textContent = error.message;
    } finally {
      saving = false;
      confirm.disabled = monthField.disabled = false;
      revision.disabled = !report;
      if (report) {
        saveButton.disabled = !report.preview?.rows.length;
        recalculate.disabled = !report.revisions.length;
      }
    }
  }

  monthField.onchange = load;
  revision.onchange = draw;
  saveButton.onclick = () => save(null);
  recalculate.onclick = () => {
    expectedRevision = report.revisions.at(-1).id;
    reasonText.value = '';
    byId('spmScoreReasonStatus').textContent = '';
    reasonDialog.showModal();
  };
  byId('spmScoreCancel').onclick = () => { if (!saving) reasonDialog.close(); };
  reasonDialog.oncancel = event => { if (saving) event.preventDefault(); };
  byId('spmScoreReasonForm').onsubmit = event => {
    event.preventDefault();
    save(expectedRevision, reasonText.value);
  };

  return { render(data) { if (lastData !== data) { lastData = data; load(); } } };
})();

