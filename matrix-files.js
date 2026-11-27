'use strict';

globalThis.spmMatrixFiles = (() => {
  const megabyte = 1024 * 1024;
  const maximum = 50 * megabyte;
  const decimal = new Intl.NumberFormat('ru', { maximumFractionDigits: 2 });
  const integer = new Intl.NumberFormat('ru');
  const showSize = size => Number.isSafeInteger(size) && size >= 0
    ? decimal.format(size / megabyte) + ' МБ (' + integer.format(size) + ' байт)' : 'размер неизвестен';
  const pause = () => new Promise(resolve => setTimeout(resolve, 0));
  const fingerprint = async raw => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
    byte => byte.toString(16).padStart(2, '0')).join('');

  class ReadError extends Error {
    constructor(message, size, partial = false) {
      super(message);
      this.size = size;
      this.partial = partial;
    }
  }

  function checkSize(size, partial = false) {
    if (!(size > maximum)) return;
    throw new ReadError('Файл превышает 50 МБ: ' + (partial ? 'получено не менее ' : '') + showSize(size)
      + '. Допустимый максимум — 50 МБ.', size, partial);
  }

  async function read(stream, { size: expected, signal, progress = () => {} } = {}) {
    checkSize(expected);
    if (!stream) throw new ReadError('Поток чтения недоступен.', expected);
    const reader = stream.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const parts = [];
    let size = 0, reported = 0;
    function decode(chunk, options) {
      try { return decoder.decode(chunk, options); }
      catch (error) {
        if (!(error instanceof TypeError)) throw error;
        throw new ReadError('Файл содержит некорректный UTF-8.', size, true);
      }
    }
    try {
      while (true) {
        signal?.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        checkSize(size, true);
        parts.push(decode(value, { stream: true }));
        if (size - reported >= megabyte) {
          reported = size;
          progress(size);
          await pause();
        }
      }
      signal?.throwIfAborted();
      if (Number.isSafeInteger(expected) && expected >= 0 && size !== expected) {
        throw new ReadError('Получено ' + showSize(size) + ', ожидалось ' + showSize(expected) + '. Файл неполный или изменился.', size);
      }
      parts.push(decode());
      progress(size);
      return { raw: parts.join(''), size };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ReadError) throw error;
      throw new ReadError(error instanceof RangeError ? 'Недостаточно памяти для чтения JSON.'
        : 'Ошибка чтения или обрыв соединения. Получено ' + showSize(size) + '.', size, true);
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  return { maximum, showSize, checkSize, read, pause, fingerprint, ReadError };
})();
