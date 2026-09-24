// Единственная точка обращения UI к серверу. Моки и демо-данные живут на сервере, не здесь.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code ?? 'http_error';
    this.fields = body?.error?.fields ?? null;
  }
}

const deviceTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function request(method, path, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Time-Zone': deviceTimeZone,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, { error: { code: 'network', message: 'Нет соединения' } });
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith('/api/session')) {
    const returnTo = location.pathname + location.search;
    location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const qs = (params) => {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, v);
  const str = s.toString();
  return str ? `?${str}` : '';
};

export const api = {
  session: () => request('GET', '/api/session'),
  demoUsers: () => request('GET', '/api/demo-users'),
  login: (userId) => request('POST', '/api/session', { userId }),
  logout: () => request('DELETE', '/api/session'),

  listEvents: (params, opts) => request('GET', `/api/events${qs(params)}`, undefined, opts),
  listAttention: (params, opts) => request('GET', `/api/events/attention${qs(params)}`, undefined, opts),
  getEvent: (id, opts) => request('GET', `/api/events/${encodeURIComponent(id)}`, undefined, opts),
  createEvent: (body) => request('POST', '/api/events', body),
  archiveEvent: (id) => request('POST', `/api/events/${encodeURIComponent(id)}/archive`, {}),
  restoreEvent: (id) => request('POST', `/api/events/${encodeURIComponent(id)}/restore`, {}),
  completeTask: (eventId, taskId) => request('POST',
    `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}/complete`, {}),
  restoreTask: (eventId, taskId) => request('POST',
    `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}/restore`, {}),
  retryPlan: (id) => request('POST', `/api/events/${encodeURIComponent(id)}/plan`, {}),

  listTasks: (eventId, params, opts) => request('GET',
    `/api/events/${encodeURIComponent(eventId)}/tasks${qs(params)}`, undefined, opts),
  getTask: (eventId, taskId, opts) => request('GET',
    `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}`, undefined, opts),
  createTask: (eventId, body) => request('POST', `/api/events/${encodeURIComponent(eventId)}/tasks`, body),
  updateTask: (eventId, taskId, body) => request('PATCH',
    `/api/events/${encodeURIComponent(eventId)}/tasks/${encodeURIComponent(taskId)}`, body),
};
