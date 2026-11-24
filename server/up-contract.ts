/**
 * Внутренний контракт между backend и супервизором `up`.
 *
 * `ACC_UP_SUPERVISED=1` получает только backend, запущенный из `up --supervised`.
 * Такой backend не порождает второй процесс на том же порту, а завершается кодом
 * `BACKEND_RESTART_EXIT_CODE`, чтобы перезапуском управлял владелец стенда.
 */
export const UP_SUPERVISED_ENV = 'ACC_UP_SUPERVISED';

/** Backend штатно завершился и просит супервизора поднять его заново. */
export const BACKEND_RESTART_EXIT_CODE = 75;
