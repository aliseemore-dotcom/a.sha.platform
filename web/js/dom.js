// Построение DOM без innerHTML: весь пользовательский текст попадает в узлы как текст.

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
}

let announceTimer;
/** Сообщение для экранного диктора (aria-live=polite), с задержкой против спама. */
export function announce(text, delay = 400) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    const node = document.getElementById('announcer');
    if (node) node.textContent = text;
  }, delay);
}
