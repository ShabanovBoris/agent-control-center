/**
 * Регистрация нужна и для installability, и для кликов по уже показанным уведомлениям.
 * Ошибку не логируем: диалог уведомлений сам объяснит состояние.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('/sw.js').catch(() => {});
}
