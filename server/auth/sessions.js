// Сессии входа (docs/specs/08-foundation.md, §2.3). В базе — только SHA-256 токена; сам токен
// живёт лишь в cookie и нигде не хранится, поэтому утечка базы не даёт войти чужими сессиями.

import { randomBytes, createHash } from 'node:crypto';

export const SESSION_DAYS = 30;
const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // не чаще раза в час — не пишем в базу на каждый запрос
const USER_AGENT_MAX = 200;

export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSession(store, userId, userAgent, now) {
  const token = randomBytes(32).toString('base64url');
  const nowIso = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_DAYS * 86400_000).toISOString();
  store.insertSession({
    idHash: hashToken(token), userId, createdAt: nowIso, lastSeenAt: nowIso, expiresAt,
    userAgent: (userAgent ?? '').slice(0, USER_AGENT_MAX),
  });
  return { token, expiresAt };
}

/** Возвращает пользователя сессии и продлевает срок при активности; `null`, если сессии нет или истекла. */
export function resolveSession(store, token, now) {
  if (!token) return null;
  const idHash = hashToken(token);
  const session = store.getSessionByIdHash(idHash);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= now) {
    store.deleteSession(idHash);
    return null;
  }
  const user = store.getUser(session.userId);
  if (!user || user.status !== 'active') return null;

  if (now - Date.parse(session.lastSeenAt) > TOUCH_INTERVAL_MS) {
    store.touchSession(idHash, {
      lastSeenAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_DAYS * 86400_000).toISOString(),
    });
  }
  return user;
}

export function revokeSession(store, token) {
  if (!token) return;
  store.deleteSession(hashToken(token));
}

/** Смена/сброс пароля и отключение пользователя — все сессии, кроме текущей при смене своего пароля. */
export function revokeOtherSessions(store, userId, currentToken) {
  store.deleteSessionsForUser(userId, currentToken ? hashToken(currentToken) : null);
}
