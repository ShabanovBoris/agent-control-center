# AGENTHOS-9 — команды

- [x] Подсказки AHP: проверка принадлежности, триггера и маршрута.
- [x] Меню, защита черновика и отправка команды с вложением.
- [x] Общая логика ConfigPanel и `/plan`; отображение результата `/compact`.
- [x] Автоматические проверки: typecheck, 104 теста, `git diff --check`.
- [x] Тестовые хосты: `chat/configChanged` подтвердил plan у Claude и Gemini/Codex; `/rename AGENTHOS-9 smoke` вернул `session/titleChanged` и `chat/turnComplete`.
- [ ] Успешный `/compact` на реальной истории: повторить при доступности провайдера. И первый запрос за тестовой историей, и `/compact` вернули `chat/error` с HTTP 503; хост затем прислал `chat/turnComplete`, который не должен отображаться как успех.
