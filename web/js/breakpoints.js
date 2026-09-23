// Общая точка отсчёта «мобильный/шире» для списков, у которых на узком экране меньше строк
// по умолчанию (экран 01 §3.2, обзор проекта §1.3): 3 строки на телефоне, 5 — на остальных.

export const mobileQuery = window.matchMedia('(max-width: 767px)');
export const defaultListLimit = () => (mobileQuery.matches ? 3 : 5);
