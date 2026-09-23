// Видимость и разрешения. Проверяются только на сервере; клиент фильтрацией не занимается.
//   owner  — видит все проекты своего рабочего пространства и может всё;
//   member — видит проекты, куда добавлен (event.memberIds), действует по списку permissions.

export function canSeeEvent(user, event) {
  if (!user || !event || user.workspaceId !== event.workspaceId) return false;
  return user.role === 'owner' || (event.memberIds ?? []).includes(user.id);
}

export function hasPermission(user, permission) {
  if (!user) return false;
  return user.role === 'owner' || (user.permissions ?? []).includes(permission);
}

export function visibleEvents(store, user) {
  return store.listEventsInWorkspace(user.workspaceId).filter((e) => canSeeEvent(user, e));
}
