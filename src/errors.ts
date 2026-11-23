/** Локальная отмена поиска: backend уже получил `cancelSearch`, ответ не нужен. */
export class CallCancelled extends Error {
  constructor() {
    super('Поиск отменён');
    this.name = 'CallCancelled';
  }
}
