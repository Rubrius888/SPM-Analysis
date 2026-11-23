'use strict';

globalThis.spmCloudArchive = (() => {
  const client = '6220226b8e0841189bd74e243476d93a';
  const oauth = 'https://oauth.yandex.ru';
  const api = 'https://cloud-api.yandex.net/v1/disk';
  const resources = api + '/virtual-disks/resources';
  const root = 'vd:Riy12Ntnw6jCXg:disk:/Архив ILU/Сборка';
  const { clean, identityKey, recordKey, parseMatrix, validMonth } = spmMetrics;
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' });
  const maxSize = 10 * 1024 * 1024;
  const authKey = 'spm-cloud-archive-oauth-v1';
  const writeLock = authKey + ':write';
  const loginLock = authKey + ':login';
  const subscribers = new Set();
  let session = null, phase = 'disconnected', account = '', warning = '';
  let login, timer, ready = Promise.resolve();

  function notify(next) {
    phase = next;
    for (const subscriber of subscribers) subscriber({ phase, account, warning });
  }
  function subscribe(subscriber) {
    subscribers.add(subscriber);
    subscriber({ phase, account, warning });
  }
  const locked = action => navigator.locks.request(writeLock, action);

  function saved() {
    try { return localStorage.getItem(authKey); }
    catch { return undefined; }
  }
  function install(value) {
    clearTimeout(timer);
    session?.controller.abort();
    session = value;
    account = '';
    warning = '';
    if (session) {
      const current = session;
      installExpiry(current);
    }
  }
  function installExpiry(current) {
    timer = setTimeout(() => {
      if (session !== current) return;
      if (connected()) installExpiry(current);
      else discard(current);
    }, Math.max(0, Math.min(current.expires_at - Date.now(), 2147483647)));
  }

  function cancelAuthorization() {
    const attempt = login;
    login = undefined;
    if (!attempt) return;
    clearTimeout(attempt.timer);
    attempt.controller.abort();
    attempt.release();
  }

  async function removeSaved(raw) {
    if (typeof raw !== 'string' || !navigator.locks) return;
    try {
      await locked(() => {
        if (saved() === raw) localStorage.removeItem(authKey);
      });
    } catch {
      if (!session) {
        warning = 'Не удалось удалить сохранённое подключение из данных браузера.';
        notify(phase);
      }
    }
  }
  async function discard(current, next = 'reauthorize') {
    if (session !== current) return;
    const raw = current?.raw;
    install(null);
    notify(next);
    await removeSaved(raw);
  }
  async function disconnect() {
    cancelAuthorization();
    await discard(session, 'disconnected');
  }

  function restore() {
    const raw = saved();
    if (typeof raw === 'string' && raw === session?.raw) return ready;
    if (raw === undefined) {
      warning = 'Хранилище авторизации недоступно в этом браузере.';
      notify(phase);
      return ready;
    }
    cancelAuthorization();
    const previouslyConnected = !!session;
    install(null);
    if (!raw) {
      if (previouslyConnected) notify('disconnected');
      return Promise.resolve();
    }
    let value;
    try { value = JSON.parse(raw); } catch { /* Invalid stored record. */ }
    if (typeof value?.access_token !== 'string' || !value.access_token
      || !Number.isFinite(value.expires_at) || value.expires_at <= Date.now()) {
      notify('reauthorize');
      return removeSaved(raw);
    }
    install({ ...value, raw, controller: new AbortController() });
    ready = verify(session);
    return ready;
  }
  window.addEventListener('storage', event => {
    if (event.key === authKey || event.key === null) restore();
  });
  window.addEventListener('online', () => {
    if (phase === 'offline' && connected()) ready = verify(session);
  });
  const base64 = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return NaN;
    const day = Date.parse(value.slice(0, 10));
    if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return NaN;
    return Date.parse(value);
  }
  function monthOf(timestamp) {
    const parts = Object.fromEntries(format.formatToParts(timestamp).map(part => [part.type, part.value]));
    return parts.year + '-' + parts.month;
  }
  function connected() { return !!session && Date.now() < session.expires_at; }

  async function authorizationURL() {
    if (login) throw new Error('Подключение уже начато в этой вкладке.');
    if (!navigator.locks) throw new Error('Браузер не поддерживает блокировку параллельной авторизации.');
    let release, acquired;
    const holding = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { acquired = resolve; });
    const attempt = { release, controller: new AbortController() };
    login = attempt;
    navigator.locks.request(loginLock, { ifAvailable: true }, async lock => {
      acquired(!!lock);
      if (lock) await holding;
    }).catch(() => acquired(false));
    try {
      if (!await started) throw new Error('Подключение уже открыто в другой вкладке.');
      attempt.controller.signal.throwIfAborted();
      attempt.base = saved();
      const proof = base64(crypto.getRandomValues(new Uint8Array(32)));
      const challenge = base64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(proof))));
      attempt.controller.signal.throwIfAborted();
      attempt.proof = proof;
      attempt.timer = setTimeout(cancelAuthorization, 10 * 60 * 1000);
      return oauth + '/authorize?' + new URLSearchParams({
        response_type: 'code', client_id: client, redirect_uri: oauth + '/verification_code',
        code_challenge: challenge, code_challenge_method: 'S256',
        scope: 'cloud_api:disk.read cloud_api:disk.info', force_confirm: 'yes'
      });
    } catch (error) {
      if (login === attempt) cancelAuthorization();
      throw error;
    }
  }

  async function request(url, signal, options = {}, authenticated = false) {
    const current = authenticated ? session : null;
    if (authenticated && !connected()) {
      if (current) await discard(current);
      throw new Error('Требуется повторная авторизация.');
    }
    const signals = [AbortSignal.timeout(30000), signal, current?.controller.signal].filter(Boolean);
    let response;
    try {
      response = await fetch(url, {
        credentials: 'omit', redirect: 'error', ...options, cache: 'no-store', referrerPolicy: 'no-referrer',
        signal: AbortSignal.any(signals),
        ...(current && { headers: { Authorization: 'OAuth ' + current.access_token } })
      });
    } catch (error) {
      if (current && session === current && !signal?.aborted && !current.controller.signal.aborted) notify('offline');
      throw error;
    }
    if (current && current !== session) throw new Error('Авторизация изменилась в другой вкладке.');
    if (current && response.status === 401) await discard(current);
    if (current && response.status === 403) notify('forbidden');
    if (!response.ok) {
      const error = new Error(response.status === 401 ? 'Требуется повторная авторизация · HTTP 401.'
        : response.status === 403 ? 'Нет прав доступа · HTTP 403.' : 'Яндекс: HTTP ' + response.status + '.');
      error.status = response.status;
      throw error;
    }
    return response;
  }

  async function verify(current, signal) {
    notify('restoring');
    try {
      const info = await (await request(api + '/', signal, {}, true)).json();
      if (session !== current || signal?.aborted) return;
      account = info.user?.login || info.user?.display_name || 'Имя недоступно';
      notify('connected');
    } catch (error) {
      if (session === current && !signal?.aborted && error.status !== 403) notify('offline');
    }
  }

  async function authorize(code, signal) {
    const attempt = login;
    if (!attempt?.proof || !code.trim()) throw new Error('Сначала получите новый одноразовый код.');
    const combined = AbortSignal.any([attempt.controller.signal, signal].filter(Boolean));
    try {
      const response = await request(oauth + '/token', combined, {
        method: 'POST', body: new URLSearchParams({
          grant_type: 'authorization_code', code: code.trim(), client_id: client, code_verifier: attempt.proof
        })
      });
      const result = await response.json();
      combined.throwIfAborted();
      if (typeof result.access_token !== 'string' || !result.access_token || !Number.isFinite(Number(result.expires_in))
        || Number(result.expires_in) <= 0) throw new Error('Яндекс не вернул действующий токен.');
      const value = { access_token: result.access_token, expires_at: Date.now() + Number(result.expires_in) * 1000 };
      const raw = JSON.stringify(value);
      await locked(() => {
        combined.throwIfAborted();
        if (saved() !== attempt.base) throw new Error('Подключение изменилось в другой вкладке. Повторите действие.');
        install({ ...value, raw, controller: new AbortController() });
        try { localStorage.setItem(authKey, raw); }
        catch { warning = 'Не удалось сохранить подключение. После перезапуска потребуется вход.'; }
      });
      ready = verify(session);
      await ready;
    } finally {
      if (login === attempt) cancelAuthorization();
    }
  }

  function filePath(directory, item) {
    const canonical = directory + '/' + item.name;
    const diskPath = canonical.slice(canonical.indexOf(':disk:') + 6);
    const virtualPrefix = canonical.slice(0, canonical.indexOf(':disk:') + 1);
    const diskId = virtualPrefix.slice(3, -1);
    const browserPath = 'vd:/' + diskId + '/disk' + diskPath;
    const known = [canonical, browserPath, 'disk:' + diskPath, virtualPrefix + diskPath, diskPath];
    let reported = item.path;
    if (typeof reported === 'string' && !known.includes(reported)) {
      try { reported = decodeURIComponent(reported); } catch { /* Keep the original path for validation. */ }
    }
    if (/[\\/\u0000-\u001f]/.test(item.name) || !known.includes(reported)) {
      throw new Error('Архив вернул неожиданный путь для «' + item.name + '»: ' + String(item.path).slice(0, 240));
    }
    return canonical;
  }

  async function list(directory, signal, progress) {
    const files = new Map();
    let duplicates = 0, offset = 0, total;
    do {
      const data = await (await request(resources + '?' + new URLSearchParams({
        path: directory, limit: '100', offset: String(offset), sort: 'name'
      }), signal, {}, true)).json();
      const page = data._embedded;
      if (!Array.isArray(page?.items) || !Number.isSafeInteger(page.total) || page.total < 0
        || (total !== undefined && total !== page.total) || Number(page.offset) !== offset
        || (!page.items.length && offset < page.total)) throw new Error('Список архива неполный или изменился при чтении.');
      total = page.total;
      for (const item of page.items) {
        if (item.type !== 'file' || typeof item.name !== 'string' || !/\.json$/i.test(item.name)) continue;
        const path = filePath(directory, item);
        if (files.has(path)) {
          duplicates++;
          if (files.get(path).modified !== item.modified || files.get(path).size !== item.size) {
            throw new Error('Список архива изменился при чтении.');
          }
        } else files.set(path, { ...item, path });
      }
      offset += page.items.length;
      progress('Прочитано записей архива: ' + offset + ' из ' + total);
    } while (offset < total);
    if (offset !== total) throw new Error('Чтение списка архива не завершено.');
    return { files: [...files.values()], duplicates, listingRepeated: duplicates > 0 };
  }

  function trustedDownload(url) {
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && ['yandex.net', 'yandex.ru', 'yandex.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
  }

  async function download(item, signal) {
    if (item.size > maxSize) throw new Error('Файл превышает 10 МБ.');
    let link;
    try { link = await (await request(resources + '/download?' + new URLSearchParams({ path: item.path }), signal, {}, true)).json(); }
    catch (error) { throw new Error('Получение ссылки скачивания: ' + error.message); }
    const url = new URL(link.href);
    if (link.method !== 'GET' || link.templated || !trustedDownload(url)) throw new Error('Недопустимая ссылка скачивания Яндекса.');
    let response;
    try { response = await request(url.href, signal, { redirect: 'follow' }); }
    catch (error) { throw new Error('Чтение файла по ссылке Яндекса: ' + error.message); }
    if (response.url && !trustedDownload(new URL(response.url))) throw new Error('Конечный адрес скачивания вне доменов Яндекса.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let size = 0, raw = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return raw + decoder.decode();
        size += value.length;
        if (size > maxSize) throw new Error('Файл превышает 10 МБ.');
        raw += decoder.decode(value, { stream: true });
      }
    } finally { await reader.cancel().catch(() => {}); }
  }

  const supports = department => clean(department) === 'Сборка';

  async function scan({ department, month, roster, signal, progress = () => {} }) {
    const dept = clean(department);
    if (!validMonth(month) || !dept || dept === '.' || dept === '..' || /[\\/%\u0000-\u001f]/.test(dept)) {
      throw new Error('Укажите корректный департамент и месяц.');
    }
    if (!supports(dept)) throw new Error('Облачная загрузка доступна только для департамента «Сборка».');
    const current = session;
    if (current) signal = AbortSignal.any([signal, current.controller.signal].filter(Boolean));
    const listing = await list(root, signal, progress);
    signal?.throwIfAborted();
    if (phase !== 'connected' && connected()) notify('connected');
    const groups = new Map();
    const problems = [], conflicts = [], candidates = [];
    let duplicates = listing.duplicates, unread = 0, damaged = 0, outside = 0;
    for (const [index, item] of listing.files.entries()) {
      signal?.throwIfAborted();
      progress('Проверка JSON: ' + (index + 1) + ' из ' + listing.files.length);
      let raw;
      try { raw = await download(item, signal); }
      catch (error) {
        signal?.throwIfAborted();
        if (!connected()) throw error;
        unread++;
        problems.push(item.name + ' · не прочитан: ' + error.message);
        continue;
      }
      try {
        const json = JSON.parse(raw.replace(/^\uFEFF/, ''));
        const exported = date(json.exportedAt);
        if (!Number.isFinite(exported)) throw new Error('Нет корректного exportedAt.');
        if (monthOf(exported) !== month) { outside++; continue; }
        const matrix = parseMatrix(raw, month, dept);
        const modified = date(item.modified);
        if (!groups.has(matrix.id)) groups.set(matrix.id, []);
        groups.get(matrix.id).push({ ...matrix, name: item.name, raw, exported, modified });
      } catch (error) {
        damaged++;
        problems.push(item.name + ' · отклонён: ' + error.message);
      }
    }
    for (const entries of groups.values()) {
      const distinct = [...new Map(entries.map(entry => [entry.raw, entry])).values()];
      duplicates += entries.length - distinct.length;
      const invalidDates = entries.some(entry => !Number.isFinite(entry.modified) || entry.modified < entry.exported);
      if (invalidDates || new Set(distinct.map(entry => entry.exported)).size !== distinct.length) {
        conflicts.push(entries[0].section + ' · смена ' + entries[0].shift + ' · ' + (invalidDates
          ? 'метаданные Диска не подтверждают время экспорта' : 'разные JSON с одним временем экспорта')
          + ' · ' + distinct.map(entry => entry.name).join(', '));
        continue;
      }
      candidates.push(distinct.sort((a, b) => b.exported - a.exported)[0]);
    }
    signal?.throwIfAborted();
    const expected = roster.filter(record => identityKey([record.department]) === identityKey([dept]));
    const expectedIds = new Set(expected.map(record => recordKey(month, record)));
    const found = new Set(candidates.map(record => record.id));
    const sectionKey = record => identityKey([record.department, record.workshop, record.section]);
    const knownSections = new Set(expected.map(sectionKey));
    const matched = expected.filter(record => found.has(recordKey(month, record)));
    return {
      candidates, problems, conflicts, duplicates, damaged, unread, outside, files: listing.files.length,
      listingRepeated: listing.listingRepeated,
      unknown: expected.length ? candidates.filter(record => !knownSections.has(sectionKey(record))) : [],
      extra: expected.length ? candidates.filter(record => !expectedIds.has(record.id)) : [],
      missing: expected.filter(record => !found.has(recordKey(month, record))),
      expectedShifts: expectedIds.size, foundShifts: matched.length,
      expectedSections: knownSections.size, foundSections: new Set(matched.map(sectionKey)).size
    };
  }
  return { authorizationURL, authorize, connected, disconnect, scan, supports, subscribe, restore, cancelAuthorization, ready: () => ready };
})();
