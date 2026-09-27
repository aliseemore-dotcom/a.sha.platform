// Приглашения и ссылки сброса пароля (docs/specs/08-foundation.md, §2.5–2.6). Токен в базе не
// хранится — только его хэш, как у сессий; ссылка действует один раз.

import { randomBytes } from 'node:crypto';
import { hashToken } from './sessions.js';
import { hashPassword, validatePassword } from './passwords.js';

export const INVITE_DAYS = 7;
export const RESET_HOURS = 24;

function newToken() {
  return randomBytes(24).toString('base64url');
}

/**
 * Создаёт приглашение (`kind: 'invite'`) или ссылку сброса (`kind: 'reset'`). Активное
 * неиспользованное приглашение на тот же email в том же пространстве заменяется новым (§2.6).
 */
export function createInvite(store, { workspaceId, email, name, role, permissions, kind, createdBy, now }) {
  if (kind === 'invite') {
    const existing = store.findActiveInviteByEmail(workspaceId, email);
    if (existing) store.invalidateInvite(existing.tokenHash);
  }
  const token = newToken();
  const days = kind === 'reset' ? RESET_HOURS / 24 : INVITE_DAYS;
  store.insertInvite({
    tokenHash: hashToken(token),
    workspaceId,
    email: email.toLowerCase(),
    name: name ?? null,
    role: role ?? null,
    permissions: permissions ?? [],
    kind,
    expiresAt: new Date(now + days * 86400_000).toISOString(),
    usedAt: null,
    createdBy: createdBy ?? null,
    createdAt: new Date(now).toISOString(),
  });
  return token;
}

const INVALID = { ok: false, message: 'Ссылка недействительна. Попросите владельца прислать новую.' };

/** Только проверка — не помечает использованной (для отрисовки страницы `/invite/:token`). */
export function inspectInvite(store, token, now) {
  if (typeof token !== 'string' || !token) return INVALID;
  const invite = store.getInviteByTokenHash(hashToken(token));
  if (!invite || invite.usedAt || Date.parse(invite.expiresAt) <= now) return INVALID;
  return { ok: true, invite };
}

/**
 * Принять приглашение: создаёт нового пользователя (владелец или участник — как задал
 * пригласивший). Принять ссылку сброса: меняет пароль существующего пользователя и отзывает его
 * старые сессии. Обе операции — целиком в транзакции (docs/specs/08-foundation.md, §1.4).
 */
export function acceptInvite(store, token, { name, password }, now) {
  const check = inspectInvite(store, token, now);
  if (!check.ok) return check;
  const { invite } = check;

  const passwordError = validatePassword(password);
  if (passwordError) return { ok: false, field: 'password', message: passwordError };

  return store.transaction(() => {
    if (invite.kind === 'invite') {
      if (store.findUserByEmail(invite.email)) return INVALID; // занято другим пользователем — та же ошибка
      const trimmedName = String(name ?? invite.name ?? '').trim();
      if (!trimmedName) return { ok: false, field: 'name', message: 'Укажите имя' };
      const nowIso = new Date(now).toISOString();
      const user = {
        id: store.newId('usr'),
        workspaceId: invite.workspaceId,
        email: invite.email,
        name: trimmedName,
        role: invite.role ?? 'member',
        permissions: invite.permissions ?? [],
        passwordHash: hashPassword(password),
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
        lastLoginAt: null,
      };
      store.insertUser(user);
      store.markInviteUsed(invite.tokenHash, nowIso);
      return { ok: true, user };
    }

    // reset
    const user = store.findUserByEmail(invite.email);
    if (!user) return INVALID;
    const nowIso = new Date(now).toISOString();
    store.updateUser(user.id, { passwordHash: hashPassword(password), updatedAt: nowIso });
    store.markInviteUsed(invite.tokenHash, nowIso);
    store.deleteSessionsForUser(user.id, null);
    return { ok: true, user: store.getUser(user.id) };
  });
}
