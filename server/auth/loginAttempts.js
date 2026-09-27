// Ограничение попыток входа (docs/specs/08-foundation.md, §2.4): не больше 5 неудачных за 15
// минут на пару «email + IP» и не больше 30 на IP.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_EMAIL_IP = 5;
const MAX_PER_IP = 30;
const PRUNE_AGE_MS = 24 * 3600_000;

const emailIpKey = (email, ip) => `${String(email ?? '').toLowerCase()}|${ip}`;

export function isLoginLocked(store, email, ip, now) {
  const since = now - WINDOW_MS;
  if (store.countLoginAttempts(emailIpKey(email, ip), since) >= MAX_PER_EMAIL_IP) return true;
  if (store.countLoginAttemptsByIp(ip, since) >= MAX_PER_IP) return true;
  return false;
}

export function recordFailedLogin(store, email, ip, now) {
  store.insertLoginAttempt({ key: emailIpKey(email, ip), ip, at: now });
  store.pruneLoginAttempts(now - PRUNE_AGE_MS);
}
