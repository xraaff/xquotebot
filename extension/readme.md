# Extension — install on any Chrome

## Install

1. Создай папку `extension/` и положи туда:
   - `manifest.json`
   - `background.js`
   - `content.js`
   - `popup.html`
   - `popup.js`
   - `styles.css`
   - `icons/icon16.png`, `icons/icon48.png`, `icons/icon128.png` (любые квадратные PNG)
2. Chrome → `chrome://extensions` → **Developer mode ON** → **Load unpacked** → выбери папку.
3. Иконка плагина в toolbar → popup → вставь:
   - **Bridge URL:** `https://bridge-xxx.up.railway.app` (без trailing `/`)
   - **Bridge Token:** значение переменной `BRIDGE_TOKEN` в Railway
4. Нажми **Save**, потом **Test** — должна появиться надпись «bridge reachable».
5. Открой новую вкладку → https://x.com → **оставь открытым**. Любые URL квот, кинутые в Telegram-бота, будут обрабатываться автоматически.

## Anti-bot limits (выставлены в bridge)

- max 8 постов/час, 30/день
- минимум 1.5 мин между постами (рандом до 4 мин)
- лайк перед реплаем, human-like посимвольный ввод
- если shadowban — уменьши `MAX_PER_DAY=15` в Railway env vars

## Несколько ноутов

Можно поставить плагин на любой Chrome и подключить к одному bridge (тот же URL + Token). Bridge dequeue-ит по одной задаче → кто первый опросил, тот и обработал. **Но:** не ставь две вкладки x.com параллельно с одного аккаунта — паттерн очевиден. Один Chrome = один x.com = один аккаунт. Для второго аккаунта — поставь плагин на другой профиль Chrome на любом ноуте, второй не зайдёт с тем же URL потому что x.com требует логин в свой профиль. Очередь общая, лимиты общие.