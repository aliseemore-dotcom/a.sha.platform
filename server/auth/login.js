// Вход по email и паролю (docs/specs/08-foundation.md, §2.4).

import { verifyPassword } from './passwords.js';
import { createSession } from './sessions.js';
import { isLoginLocked, recordFailedLogin } from './loginAttempts.js';

export const GENERIC_ERROR = 'Неверный email или пароль';
export const LOCKED_ERROR = 'Слишком много попыток. Попробуйте через 15 минут.';

export function attemptLogin(store, email, password, ip, userAgent, now) {
  const normalizedEmail = String(email ?? '').trim().toLowerCase();

  if (isLoginLocked(store, normalizedEmail, ip, now)) {
    return { ok: false, locked: true, message: LOCKED_ERROR };
  }

  const user = store.findUserByEmail(normalizedEmail);
  const valid = user && user.status === 'active' && user.passwordHash
    && verifyPassword(String(password ?? ''), user.passwordHash);

  if (!valid) {
    recordFailedLogin(store, normalizedEmail, ip, now);
    return { ok: false, locked: false, message: GENERIC_ERROR };
  }

  store.updateUser(user.id, { lastLoginAt: new Date(now).toISOString() });
  const { token, expiresAt } = createSession(store, user.id, userAgent, now);
  return { ok: true, token, expiresAt, user: store.getUser(user.id) };
}
