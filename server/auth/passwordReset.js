// Самостоятельный запрос сброса пароля по email (без администратора — раньше сброс мог
// инициировать только владелец пространства другому участнику, docs/specs/08-foundation.md,
// §2.6). Ответ всегда одинаковый независимо от того, найден ли email, чтобы не раскрывать,
// зарегистрирован ли адрес.

import { createInvite, RESET_HOURS } from './invites.js';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL_IP = 5;

const key = (email, ip) => `pwreset:${String(email ?? '').toLowerCase()}|${ip}`;

/** Возвращает `{ token, email }`, если можно создать ссылку сброса, иначе `null` — оба случая
 * (email не найден, слишком много попыток) отвечают вызывающему коду одинаково успешно. */
export function requestPasswordReset(store, email, ip, now) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();
  const k = key(normalizedEmail, ip);
  if (store.countLoginAttempts(k, now - WINDOW_MS) >= MAX_PER_EMAIL_IP) return null;
  store.insertLoginAttempt({ key: k, ip, at: now });

  const user = normalizedEmail && store.findUserByEmail(normalizedEmail);
  if (!user || user.status !== 'active') return null;

  const token = createInvite(store, {
    workspaceId: user.workspaceId, email: user.email, name: user.name, role: user.role,
    permissions: user.permissions, kind: 'reset', createdBy: null, now,
  });
  return { token, email: user.email };
}

export { RESET_HOURS };
