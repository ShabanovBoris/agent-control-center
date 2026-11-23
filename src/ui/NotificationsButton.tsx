import { useId, useRef, useState } from 'react';
import type { PushConfigResult, PushTestResult } from '../../shared/protocol';
import { describeError, store } from '../store';
import {
  isIosDevice, isStandalone, pushAvailability, toPushSubscriptionPayload, urlBase64ToUint8Array,
  type PushAvailability,
} from '../push';

interface PushState {
  availability?: PushAvailability;
  publicKey?: string;
  error?: string;
  notice?: string;
}

type Busy = 'enable' | 'disable' | 'test';

const SUPPORTED_TEXT = 'Нужен запущенный backend на Mac: он хранит ключи и отправляет уведомления.';

export function NotificationsButton({ connected }: { connected: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const [busy, setBusy] = useState<Busy>();
  const [state, setState] = useState<PushState>({});

  const inspect = async () => {
    const registration = 'serviceWorker' in navigator
      ? await navigator.serviceWorker.getRegistration('/').catch(() => undefined)
      : undefined;
    const subscription = registration?.pushManager
      ? await registration.pushManager.getSubscription().catch(() => null)
      : null;
    let publicKey: string | undefined;
    let error: string | undefined;
    try {
      publicKey = (await store.call<PushConfigResult>({ op: 'pushConfig' })).publicKey;
    } catch (reason) {
      error = describeError(reason);
    }
    const availability = pushAvailability({
      secureContext: window.isSecureContext,
      serviceWorker: 'serviceWorker' in navigator,
      pushManager: 'PushManager' in window,
      permission: typeof Notification === 'undefined' ? undefined : Notification.permission,
      isIos: isIosDevice(navigator.userAgent, navigator.maxTouchPoints),
      standalone: isStandalone(
        matchMedia('(display-mode: standalone)').matches,
        (navigator as Navigator & { standalone?: boolean }).standalone,
      ),
      hasSubscription: subscription !== null,
    });
    setState(previous => ({
      availability,
      publicKey,
      ...(error ? { error } : {}),
      ...(previous.notice ? { notice: previous.notice } : {}),
    }));
  };

  const enable = async () => {
    setBusy('enable');
    setState(previous => ({ ...previous, error: undefined, notice: undefined }));
    try {
      // Разрешение запрашиваем первым действием из клика: iOS не показывает запрос после await.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        await inspect();
        setState(previous => ({ ...previous, error: 'Уведомления не разрешены. Разрешите их в настройках браузера и повторите.' }));
        return;
      }
      const publicKey = state.publicKey ?? (await store.call<PushConfigResult>({ op: 'pushConfig' })).publicKey;
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const key = urlBase64ToUint8Array(publicKey);
      let subscription: PushSubscription;
      try {
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      } catch (error) {
        // Старая подписка осталась от прежних VAPID-ключей: снимаем её и подписываемся заново.
        if (!(error instanceof DOMException) || error.name !== 'InvalidStateError') throw error;
        const stale = await registration.pushManager.getSubscription();
        const endpoint = stale?.endpoint;
        await stale?.unsubscribe();
        if (endpoint) await store.call({ op: 'pushUnsubscribe', endpoint }).catch(() => {});
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      try {
        await store.call({
          op: 'pushSubscribe',
          origin: location.origin,
          subscription: toPushSubscriptionPayload(subscription.toJSON()),
        });
      } catch (error) {
        // Без записи на backend уведомления не придут: не оставляем «включённое» состояние.
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }
      setState(previous => ({ ...previous, notice: 'Уведомления включены на этом устройстве.' }));
      await inspect();
    } catch (error) {
      setState(previous => ({ ...previous, error: describeError(error) }));
    } finally {
      setBusy(undefined);
    }
  };

  const disable = async () => {
    setBusy('disable');
    setState(previous => ({ ...previous, error: undefined, notice: undefined }));
    try {
      const registration = await navigator.serviceWorker.getRegistration('/');
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        const endpoint = subscription.endpoint;
        await subscription.unsubscribe();
        // Если backend недоступен, запись умрёт сама по 410; локально уведомлений уже не будет.
        await store.call({ op: 'pushUnsubscribe', endpoint }).catch(() => {
          setState(previous => ({ ...previous, notice: 'Локально уведомления выключены, но backend не ответил. Запись устройства удалится при первой неудачной отправке.' }));
        });
      }
      setState(previous => ({ ...previous, notice: 'Уведомления выключены на этом устройстве.' }));
      await inspect();
    } catch (error) {
      setState(previous => ({ ...previous, error: describeError(error) }));
    } finally {
      setBusy(undefined);
    }
  };

  const sendTest = async () => {
    setBusy('test');
    setState(previous => ({ ...previous, error: undefined, notice: undefined }));
    try {
      const { delivered } = await store.call<PushTestResult>({ op: 'pushTest', origin: location.origin });
      setState(previous => ({
        ...previous,
        ...(delivered > 0
          ? { notice: 'Тестовое уведомление отправлено.' }
          : { error: 'Push-сервис не принял ни одной подписки. Проверьте, что уведомления включены на этом устройстве.' }),
      }));
    } catch (error) {
      setState(previous => ({ ...previous, error: describeError(error) }));
    } finally {
      setBusy(undefined);
    }
  };

  const availability = state.availability;
  const canEnable = availability?.kind === 'off' && connected && state.publicKey !== undefined;

  return (
    <>
      <button
        className="updates-button"
        type="button"
        aria-haspopup="dialog"
        title="Уведомления"
        disabled={!connected}
        onClick={() => {
          dialog.current?.showModal();
          void inspect();
        }}
      >Уведомления</button>
      <dialog ref={dialog} className="dialog notifications-dialog" aria-labelledby={heading}>
        <h3 id={heading}>Уведомления</h3>
        {!availability ? <p role="status">Проверяем…</p> : (
          <>
            {availability.kind === 'on' && <p role="status">Уведомления включены на этом устройстве.</p>}
            {availability.kind === 'off' && <p>Уведомления выключены. Включите их, чтобы узнавать о вопросах и завершении хода с телефона.</p>}
            {(availability.kind === 'install' || availability.kind === 'blocked' || availability.kind === 'unsupported')
              && <p role="status">{availability.reason}</p>}
            <p className="muted">
              Уведомления приходят при подтверждении инструмента, вопросе агента, завершении хода и ошибке.
              Только на смену состояния: повторные снимки не дублируются, а устройство, где сессия уже открыта,
              push не получает.
            </p>
            {state.error && <p className="error-text" role="alert">{state.error}</p>}
            {state.notice && <p role="status">{state.notice}</p>}
            {availability.kind === 'off' && !state.publicKey && <p className="muted">{SUPPORTED_TEXT}</p>}
          </>
        )}
        <div className="dialog-actions">
          {canEnable && (
            <button className="primary" type="button" disabled={busy !== undefined} onClick={() => void enable()}>
              {busy === 'enable' ? 'Включаем…' : 'Включить'}
            </button>
          )}
          {availability?.kind === 'on' && (
            <>
              <button type="button" disabled={busy !== undefined || !connected} onClick={() => void sendTest()}>
                {busy === 'test' ? 'Отправляем…' : 'Проверить уведомление'}
              </button>
              <button type="button" disabled={busy !== undefined} onClick={() => void disable()}>
                {busy === 'disable' ? 'Выключаем…' : 'Выключить'}
              </button>
            </>
          )}
          <button type="button" disabled={busy !== undefined} onClick={() => dialog.current?.close()}>Закрыть</button>
        </div>
      </dialog>
    </>
  );
}
