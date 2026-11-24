import { Fragment } from 'react';
import type { UsageAggregate, UsageModelBucket } from '../shared/usage';
import { formatTokens, formatUsageDay, formatUsageTotal } from './usage-format';

function ModelRows({ models, prefix }: { models: readonly UsageModelBucket[]; prefix: string }) {
  return models.map(model => (
    <tr key={`${prefix}\u0000${model.model ?? ''}`} className="usage-model-row">
      <td />
      <td>{model.model ?? 'Без модели'}</td>
      <td>{formatUsageTotal(model.total, model.partial)}</td>
      <td>{formatTokens(model.input)}</td>
      <td>{formatTokens(model.output)}</td>
      <td>{formatTokens(model.cached)}</td>
    </tr>
  ));
}

/**
 * Таблицы «день × модель» и «модель». Числа с `≥` — нижняя граница: в отличие от
 * сырых токенов, сумма помечена как неполная на всех уровнях.
 */
export function UsageTables({ usage, timeZone }: { usage: UsageAggregate; timeZone: string }) {
  return (
    <div className="usage-tables">
      {usage.partial && (
        <p className="usage-partial">
          Нижняя граница: часть данных хоста или истории не загружена.
        </p>
      )}
      {usage.days.length > 0 ? (
        <table className="usage-table">
          <caption>По дням ({timeZone})</caption>
          <thead>
            <tr>
              <th scope="col">День</th>
              <th scope="col">Модель</th>
              <th scope="col">Токены</th>
              <th scope="col">Вход</th>
              <th scope="col">Выход</th>
              <th scope="col">Кэш</th>
            </tr>
          </thead>
          <tbody>
            {usage.days.map(day => (
              <Fragment key={day.day}>
                <tr className="usage-day-row">
                  <th scope="row">{formatUsageDay(day.day)}</th>
                  <td>Все модели</td>
                  <td>{formatUsageTotal(day.total, day.partial)}</td>
                  <td>{formatTokens(day.input)}</td>
                  <td>{formatTokens(day.output)}</td>
                  <td>{formatTokens(day.cached)}</td>
                </tr>
                <ModelRows models={day.models} prefix={day.day} />
              </Fragment>
            ))}
          </tbody>
        </table>
      ) : <p className="muted">Нет данных о расходе по дням.</p>}
      {usage.models.length > 0 && (
        <table className="usage-table">
          <caption>По моделям</caption>
          <thead>
            <tr>
              <th scope="col">Модель</th>
              <th scope="col">Токены</th>
              <th scope="col">Вход</th>
              <th scope="col">Выход</th>
              <th scope="col">Кэш</th>
            </tr>
          </thead>
          <tbody>
            {usage.models.map(model => (
              <tr key={model.model ?? ''} className="usage-model-row">
                <th scope="row">{model.model ?? 'Без модели'}</th>
                <td>{formatUsageTotal(model.total, model.partial)}</td>
                <td>{formatTokens(model.input)}</td>
                <td>{formatTokens(model.output)}</td>
                <td>{formatTokens(model.cached)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
