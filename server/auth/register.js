// Открытая регистрация: посетитель сайта создаёт себе новое пространство и становится его
// владельцем — компания, имя, email, пароль. Раньше пространства создавал только администратор
// платформы консольной командой (docs/specs/08-foundation.md, §2.5); это осознанно изменено —
// продукт открыт для самостоятельной регистрации любым агентством.

import { ServiceError } from '../errors.js';
import { isValidTimeZone } from '../time.js';
import { hashPassword, validatePassword } from './passwords.js';

const COMPANY_MAX = 80;
const NAME_MAX = 60;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEFAULT_TIME_ZONE = 'Europe/Moscow';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_IP = 5;

/** Не больше 5 регистраций в час с одного IP — та же таблица, что и попытки входа, свой ключ. */
function checkRegisterRate(store, ip, now) {
  return store.countLoginAttempts(`register:${ip}`, now - WINDOW_MS) < MAX_PER_IP;
}
function recordRegisterAttempt(store, ip, now) {
  store.insertLoginAttempt({ key: `register:${ip}`, ip, at: now });
}

export function registerWorkspace(store, { companyName, ownerName, email, password, timeZone }, ip, now) {
  if (!checkRegisterRate(store, ip, now)) {
    throw new ServiceError(429, 'too_many_requests', 'Слишком много попыток регистрации. Попробуйте позже.');
  }
  recordRegisterAttempt(store, ip, now);

  const trimmedCompany = String(companyName ?? '').trim();
  const trimmedOwner = String(ownerName ?? '').trim();
  const normalizedEmail = String(email ?? '').trim().toLowerCase();

  const fields = {};
  if (!trimmedCompany) fields.companyName = 'Укажите название компании';
  else if ([...trimmedCompany].length > COMPANY_MAX) fields.companyName = `Не более ${COMPANY_MAX} символов`;
  if (!trimmedOwner) fields.ownerName = 'Укажите имя';
  else if ([...trimmedOwner].length > NAME_MAX) fields.ownerName = `Не более ${NAME_MAX} символов`;
  if (!EMAIL_RE.test(normalizedEmail)) fields.email = 'Укажите email';
  else if (store.findUserByEmail(normalizedEmail)) fields.email = 'Этот email уже занят';
  const passwordError = validatePassword(password);
  if (passwordError) fields.password = passwordError;
  if (Object.keys(fields).length) throw new ServiceError(422, 'validation', 'Проверьте поля формы', fields);

  const resolvedTimeZone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;

  return store.transaction(() => {
    const nowIso = new Date(now).toISOString();
    const workspaceId = store.newId('ws');
    store.insertWorkspace({ id: workspaceId, name: trimmedCompany, timeZone: resolvedTimeZone, createdAt: nowIso, updatedAt: nowIso });
    const user = {
      id: store.newId('usr'), workspaceId, email: normalizedEmail, name: trimmedOwner,
      role: 'owner', permissions: [], passwordHash: hashPassword(password), status: 'active',
      createdAt: nowIso, updatedAt: nowIso, lastLoginAt: nowIso,
    };
    store.insertUser(user);
    return user;
  });
}
