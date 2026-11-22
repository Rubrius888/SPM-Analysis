'use strict';

globalThis.spmDepartmentPicker = (root, normalize) => {
  const pictograms = new Map([
    ['Сборка', 'M3 21V10l6 3V9l6 3V4h4l2 17H3ZM7 17h1m3 0h1m3 0h1'],
    ['Сварка', 'M8 5h11v12l-5 4-6-4V5Zm2 3h7v4h-7V8ZM3 8h2M4 4l2 2m-2 6 2-2'],
    ['Окраска', 'M6 9h11v5h-5l-2 6H7l2-6H6V9Zm2 0V5h6v4m3 2h3m0-4 2-1m-2 9 2 1'],
    ['Логистика', 'm3 7 9-4 9 4v10l-9 4-9-4V7Zm0 0 9 4 9-4m-9 4v10M7.5 5l9 4v4'],
    ['Качество', 'M12 3c3 2 6 3 8 3v6c0 4-3 7-8 9-5-2-8-5-8-9V6c2 0 5-1 8-3Zm-4 9 3 3 5-6']
  ].map(([name, path]) => [normalize(name), { name, path }]));
  const defaults = [...pictograms.values()].map(icon => icon.name);
  const input = root.querySelector('input');
  const selectedIcon = root.querySelector('.department-selected-icon');
  const toggle = root.querySelector('button');
  const menu = root.querySelector('.department-menu');
  const list = menu.querySelector('ul');
  const empty = menu.querySelector('p');
  let options = defaults;
  let visible = [];
  let query = '';
  let active = -1;
  let committing = false;

  function renderIcon(host, value) {
    const icon = pictograms.get(normalize(value));
    if (host.dataset.department === icon?.name) return;
    host.replaceChildren();
    host.hidden = !icon;
    if (!icon) {
      delete host.dataset.department;
      return;
    }
    host.dataset.department = icon.name;
    const namespace = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(namespace, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS(namespace, 'path');
    path.setAttribute('d', icon.path);
    svg.append(path);
    host.append(svg);
  }

  function focusOption(index) {
    active = index;
    [...list.children].forEach((option, position) => {
      option.classList.toggle('is-active', position === index);
    });
    const option = list.children[index];
    if (option) {
      input.setAttribute('aria-activedescendant', option.id);
      option.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function draw() {
    visible = options.filter(value => normalize(value).includes(query));
    list.replaceChildren(...visible.map((value, index) => {
      const option = document.createElement('li');
      option.id = 'department-option-' + index;
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', normalize(value) === normalize(input.value));
      const icon = document.createElement('span');
      icon.className = 'department-icon';
      icon.hidden = true;
      icon.setAttribute('aria-hidden', 'true');
      renderIcon(icon, value);
      const label = document.createElement('span');
      label.textContent = value;
      option.append(icon, label);
      option.addEventListener('pointerdown', event => event.preventDefault());
      option.addEventListener('click', () => choose(index));
      return option;
    }));
    empty.hidden = visible.length > 0;
    focusOption(-1);
  }

  function open(filter = '') {
    query = filter;
    menu.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    draw();
  }

  function close() {
    menu.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    focusOption(-1);
  }

  function choose(index) {
    if (visible[index] === undefined) return;
    input.value = visible[index];
    close();
    input.focus({ preventScroll: true });
    committing = true;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    committing = false;
  }

  input.addEventListener('click', () => { if (menu.hidden) open(); });
  input.addEventListener('input', () => { if (!committing) open(normalize(input.value)); });
  toggle.addEventListener('pointerdown', event => event.preventDefault());
  toggle.addEventListener('click', () => {
    input.focus({ preventScroll: true });
    if (menu.hidden) open();
    else close();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      if (menu.hidden) open();
      if (!visible.length) return;
      const index = active === -1 ? (direction > 0 ? 0 : visible.length - 1)
        : (active + direction + visible.length) % visible.length;
      focusOption(index);
    } else if (!menu.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (!menu.hidden && (event.key === 'Enter' || (event.key === ' ' && active >= 0))) {
      event.preventDefault();
      if (active >= 0) choose(active);
      else close();
    }
  });
  root.addEventListener('focusout', event => { if (!root.contains(event.relatedTarget)) close(); });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) close(); });

  return {
    update(saved) {
      renderIcon(selectedIcon, input.value);
      const names = new Map(defaults.map(value => [normalize(value), value]));
      for (const value of saved.toSorted((a, b) => a.localeCompare(b, 'ru'))) {
        if (!names.has(normalize(value))) names.set(normalize(value), value);
      }
      const next = [...names.values()];
      if (next.length !== options.length || next.some((value, index) => value !== options[index])) {
        options = next;
        if (!menu.hidden) draw();
      }
      if (root.hidden) close();
    }
  };
};
