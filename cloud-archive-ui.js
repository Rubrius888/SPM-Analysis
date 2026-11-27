'use strict';

(() => {
  const archive = spmCloudArchive;
  const fileSize = spmMatrixFiles.showSize;
  const dialog = byId('cloudDialog');
  const preview = byId('cloudPreview');
  const status = byId('cloudStatus');
  const codeForm = byId('cloudCodeForm');
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' });
  const label = row => row.workshop + ' / ' + row.section + ' · смена ' + row.shift;
  let selection, result, operation, writing = false;
  let auth = { phase: 'disconnected', account: '', warning: '' };
  const states = {
    restoring: 'Восстанавливаем подключение...',
    connected: 'Яндекс Диск подключён',
    reauthorize: 'Требуется повторная авторизация',
    forbidden: 'Нет прав доступа',
    offline: 'Нет соединения',
    disconnected: 'Яндекс не подключён.'
  };

  function controls() {
    const connected = archive.connected();
    byId('cloudConnect').hidden = connected;
    byId('cloudDisconnect').hidden = !connected;
    byId('cloudScan').hidden = !connected;
    const text = states[auth.phase] + (auth.account ? ' · ' + auth.account : '') + (auth.warning ? ' · ' + auth.warning : '');
    byId('cloudAccount').textContent = text;
    byId('cloudConnection').textContent = auth.phase === 'disconnected' && !auth.warning ? '' : text;
    for (const node of dialog.querySelectorAll('button, input')) {
      if (node.id !== 'cloudClose') node.disabled = !!operation;
    }
    byId('cloudClose').disabled = writing;
  }

  async function run(action, write = false) {
    if (operation) return;
    const controller = new AbortController();
    operation = controller;
    writing = write;
    controls();
    try { await action(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) {
        status.textContent = error instanceof TypeError ? 'Сетевой запрос не выполнен. Проверьте сеть и доступ браузера к API (CORS).' : error.message;
      }
    } finally {
      if (operation === controller) {
        operation = undefined;
        writing = false;
        controls();
      }
    }
  }

  function warnings(title, items) {
    if (!items.length) return;
    const details = element('details');
    const list = element('ul');
    list.append(...items.map(item => element('li', item)));
    details.append(element('summary', title + ' · ' + items.length), list);
    preview.append(details);
  }

  async function showPreview(signal) {
    const local = new Map((await spmStorage.ratingMatrices(selection.month)).map(row => [row.id, row]));
    signal?.throwIfAborted();
    preview.replaceChildren();
    const { candidates, expectedShifts, foundShifts, expectedSections, foundSections, missing, extra, unknown,
      problems, checks, conflicts, unread, damaged, duplicates, outside, files, listingRepeated } = result;
    const incomplete = unread || damaged || conflicts.length || listingRepeated;
    const completeness = !expectedShifts ? 'Полнота не подтверждена · перечень не задан.'
      : missing.length || extra.length ? 'Неполная выборка.' : incomplete ? 'Полнота не подтверждена.' : 'Полная выборка.';
    preview.append(element('p', completeness + (incomplete ? ' Проверка не завершилась без исключений.' : ''), 'coverage'));
    preview.append(element('p', 'JSON в папке: ' + files + ' · выбрано версий: ' + candidates.length + ' · другой месяц: ' + outside
      + ' · дубли: ' + duplicates + ' · отклонено: ' + damaged + ' · не прочитано: ' + unread));
    if (expectedShifts) preview.append(element('p', 'Участки: ' + foundSections + ' из ' + expectedSections
      + ' · смены участков: ' + foundShifts + ' из ' + expectedShifts));
    warnings('Отсутствующие матрицы', missing.map(label));
    warnings('Неизвестные участки', unknown.map(label));
    warnings('Матрицы вне перечня', extra.map(label));
    warnings('Конфликтующие версии', conflicts);
    warnings('Ошибки файлов', problems);
    warnings('Проверенные файлы', checks.map(item => item.name + ' · ' + fileSize(item.size) + ' · ' + item.status));
    if (problems.length && candidates.length) preview.append(element('p',
      'Для импорта доступны корректные версии. Среди отклонённых файлов может быть более свежая версия.'));
    const rows = [];
    const pending = [];
    for (const item of candidates) {
      const existing = local.get(item.id);
      let state = 'Новая матрица';
      if (!existing) pending.push(item);
      else if (existing.raw === item.raw) state = 'Дубликат · будет пропущен';
      else {
        state = element('div');
        state.append(element('p', 'Локальная: ' + existing.name + ' · импорт: ' + (Number.isFinite(Date.parse(existing.importedAt)) ? date.format(new Date(existing.importedAt)) : 'дата недоступна')));
        const replace = element('button', 'Подтвердить замену');
        replace.onclick = () => {
          if (!confirm('Заменить локальную матрицу «' + existing.name + '» облачной версией «' + item.name + '»?')) return;
          run(async () => {
            data = await spmStorage.importFiles({ ...selection, source: 'cloud', files: [item], replaceId: item.id, expectedVersion: existing, progress: text => { status.textContent = text; } });
            status.textContent = data.results[0].status;
            render();
            await showPreview();
          }, true);
        };
        state.append(replace);
      }
      rows.push([label(item), item.name, fileSize(item.size), 'JSON проверен', date.format(item.exported), date.format(item.modified), state]);
    }
    if (rows.length) {
      const grid = element('div', undefined, 'scroll');
      table(grid, ['Матрица', 'Облачный JSON', 'Размер', 'Проверка', 'Экспорт (МСК)', 'Изменён на Диске (МСК)', 'Локальная версия'], rows);
      preview.append(grid);
    }
    byId('cloudImport').hidden = !pending.length;
    byId('cloudImport').onclick = () => run(async () => {
      let imported = 0, skipped = 0;
      const failures = [];
      try {
        for (let index = 0; index < pending.length; index += 100) {
          data = await spmStorage.importFiles({ ...selection, source: 'cloud', files: pending.slice(index, index + 100), progress: text => { status.textContent = text; } });
          for (const row of data.results) {
            if (row.status === 'Загружен') imported++;
            else {
              skipped++;
              failures.push(row.name + ' · ' + fileSize(row.size) + ' · ' + row.status);
            }
          }
        }
        status.textContent = 'Импортировано: ' + imported + ' · пропущено: ' + skipped + '.';
      } catch (error) {
        status.textContent = 'Импорт остановлен · сохранено: ' + imported + ' · пропущено: ' + skipped + '. ' + error.message;
      }
      render();
      await showPreview();
      warnings('Пропущенные при импорте', failures);
    }, true);
  }

  function scan() {
    return run(async signal => {
      preview.replaceChildren();
      byId('cloudImport').hidden = true;
      result = await archive.scan({ ...selection, roster: data.rosters[selection.month] ?? [], signal,
        progress: text => { status.textContent = text; } });
      await showPreview(signal);
      status.textContent = result.problems.length || result.conflicts.length || result.listingRepeated
        ? 'Предпросмотр готов с исключениями. Проверьте ошибки и список перед импортом.'
        : 'Предпросмотр готов. Проверьте список перед импортом.';
    });
  }

  byId('cloudOpen').onclick = async () => {
    selection = { department: department.value.trim(), month: month.value };
    if (!selection.department || !selection.month) { message('Выберите департамент и месяц.'); return; }
    if (!archive.supports(selection.department)) { message('Облачная загрузка доступна только для департамента «Сборка».'); return; }
    preview.replaceChildren();
    byId('cloudImport').hidden = true;
    byId('cloudScope').textContent = selection.department + ' · ' + selection.month;
    status.textContent = '';
    controls();
    dialog.showModal();
    await archive.ready();
    if (dialog.open && archive.connected()) scan();
  };
  byId('cloudConnect').onclick = () => {
    const windowForCode = window.open('about:blank', '_blank');
    if (!windowForCode) { status.textContent = 'Разрешите открытие окна авторизации Яндекса.'; return; }
    windowForCode.opener = null;
    run(async signal => {
      try {
        const url = await archive.authorizationURL();
        signal.throwIfAborted();
        windowForCode.location.href = url;
        codeForm.hidden = false;
        status.textContent = 'Введите одноразовый код с официальной страницы Яндекса.';
      } catch (error) { windowForCode.close(); throw error; }
    });
  };
  codeForm.onsubmit = event => {
    event.preventDefault();
    const input = byId('cloudCode');
    const code = input.value;
    input.value = '';
    run(async signal => {
      codeForm.hidden = true;
      await archive.authorize(code, signal);
    }).then(() => { if (dialog.open && archive.connected()) scan(); });
  };
  byId('cloudScan').onclick = scan;
  byId('cloudDisconnect').onclick = async () => {
    await archive.disconnect();
    preview.replaceChildren();
    byId('cloudImport').hidden = true;
    status.textContent = 'Аккаунт отключён.';
    controls();
  };
  byId('cloudClose').onclick = () => dialog.close();
  dialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); });
  dialog.addEventListener('close', () => {
    operation?.abort();
    operation = undefined;
    writing = false;
    archive.cancelAuthorization();
    codeForm.hidden = true;
    byId('cloudCode').value = '';
    preview.replaceChildren();
    result = undefined;
  });
  archive.subscribe(next => {
    auth = next;
    if (['restoring', 'reauthorize', 'disconnected'].includes(next.phase) && !writing) {
      preview.replaceChildren();
      byId('cloudImport').hidden = true;
    }
    if (next.phase === 'reauthorize' || next.phase === 'disconnected') {
      codeForm.hidden = true;
      byId('cloudCode').value = '';
    }
    controls();
  });
  archive.restore();
})();
