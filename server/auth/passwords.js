// Хэширование паролей (docs/specs/08-foundation.md, §2.2): `scrypt` со случайной солью и
// параметрами, хранимыми вместе с хэшем, чтобы их можно было повысить позже без миграции старых
// записей. Сравнение — `timingSafeEqual`, без исключений при разной длине буферов.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PASSWORD_MIN_LENGTH = 10;
const KEY_LENGTH = 64;
const PARAMS = { N: 2 ** 15, r: 8, p: 1 };

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH) {
    return `Пароль должен быть не короче ${PASSWORD_MIN_LENGTH} символов`;
  }
  return null;
}

/** `scrypt$N$r$p$saltHex$hashHex` — параметры хранятся в самой строке. */
export function hashPassword(password) {
  const salt = randomBytes(16);
  const { N, r, p } = PARAMS;
  const hash = scryptSync(password, salt, KEY_LENGTH, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const r = Number(rStr);
  const p = Number(pStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
