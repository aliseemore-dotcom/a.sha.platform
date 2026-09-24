// Общий тип ошибки сервисного слоя — один класс для events.js и tasks.js, чтобы
// `err instanceof ServiceError` в server/index.js работал независимо от того, где ошибка возникла.

export class ServiceError extends Error {
  constructor(status, code, message, fields) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = fields;
  }
}
