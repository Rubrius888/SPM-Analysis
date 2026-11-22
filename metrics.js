(function () {
'use strict';

const excluded = new Set(['НУ', 'ДС', 'СО']);
const isEligibleRole = role => !excluded.has(role);
const levels = new Set([null, '', 'Iкр', 'I', 'Lкр', 'L', 'U']);
const fields = ['department', 'workshop', 'section', 'shift'];
const quantities = ['posts', 'operators', 'posts2', 'posts3', 'ops2', 'ops3'];
const clean = value => String(value ?? '').normalize('NFC').trim().replace(/\s+/g, ' ');
const validMonth = value => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
const identityKey = values => JSON.stringify(values.map(value => clean(value).toLowerCase()));
const recordKey = (month, identity) => JSON.stringify([month, identityKey(fields.map(field => identity[field]))]);

function calculate(state) {
  const { posts, operators, operatorRoles, data } = state;
  if (![posts, operators, operatorRoles, data].every(Array.isArray)
      || operatorRoles.length !== operators.length || data.length !== posts.length
      || !data.every(row => Array.isArray(row) && row.length === operators.length && row.every(level => levels.has(level)))) {
    throw new Error('Некорректные поля posts, operators, operatorRoles или data.');
  }
  const eligible = operators.map((_, index) => index).filter(index => isEligibleRole(operatorRoles[index]));
  const counts = { posts: posts.length, operators: eligible.length, posts2: 0, posts3: 0, ops2: 0, ops3: 0 };
  const mastered = new Array(operators.length).fill(0);
  for (const row of data) {
    let qualified = 0;
    for (const index of eligible) {
      if (row[index] === 'L' || row[index] === 'U') {
        mastered[index]++;
        qualified++;
      }
    }
    counts.posts2 += Number(qualified >= 2);
    counts.posts3 += Number(qualified >= 3);
  }
  for (const index of eligible) {
    counts.ops2 += Number(mastered[index] >= 2);
    counts.ops3 += Number(mastered[index] >= 3);
  }
  return counts;
}

function aggregate(records) {
  const totals = Object.fromEntries(quantities.map(key => [key, 0]));
  for (const { counts } of records) {
    for (const key of quantities) totals[key] += counts[key];
  }
  const percent = (part, whole) => whole ? Math.round(part / whole * 100) : 0;
  for (const threshold of [2, 3]) {
    const posts = percent(totals['posts' + threshold], totals.posts);
    const operators = percent(totals['ops' + threshold], totals.operators);
    totals['postPercent' + threshold] = posts;
    totals['opPercent' + threshold] = operators;
    totals['total' + threshold] = Math.round((posts + operators) / 2);
  }
  return totals;
}

function parseMatrix(raw, month, department) {
  if (!validMonth(month)) throw new Error('Укажите месяц в формате ГГГГ-ММ.');
  let parsed;
  try { parsed = JSON.parse(raw.replace(/^\uFEFF/, '')); }
  catch { throw new Error('Файл содержит некорректный JSON.'); }
  const state = parsed?.state ?? parsed;
  if (!state || typeof state !== 'object') throw new Error('Матрица отсутствует.');
  const identity = Object.fromEntries(fields.map(field => [field, clean(state.filters?.[field])]));
  if (fields.some(field => !identity[field] || typeof state.filters[field] !== 'string')) {
    throw new Error('Заполните департамент, цех, участок и смену в filters.');
  }
  if (identityKey([identity.department]) !== identityKey([department])) {
    throw new Error('Департамент в матрице: ' + identity.department + '.');
  }
  return { id: recordKey(month, identity), month, ...identity, counts: calculate(state) };
}

if (typeof module !== 'undefined') module.exports = { aggregate, calculate, parseMatrix, fields, clean, validMonth, identityKey, recordKey };
else globalThis.spmMetrics = { calculate, isEligibleRole, aggregate, parseMatrix, fields, clean, validMonth, identityKey, recordKey };
})();
