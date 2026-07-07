# Quote Reply Bridge

## Деплой на Railway (1-2 минуты)

1. Залей папку `bridge/` в GitHub-репозиторий.
2. https://railway.app → **New Project → Deploy from GitHub Repo** → выбери репо.
3. Railway сам подхватит `Dockerfile`.
4. После успешного деплоя → **Variables** добавь:
   - `TELEGRAM_BOT_TOKEN` — получить у [@BotFather](https://t.me/BotFather): `/newbot`
   - `OPENROUTER_API_KEY` — https://openrouter.ai/keys (sign up, даже без денег работают `:free` модели)
   - `BRIDGE_TOKEN` — сгенерируй: запусти `openssl rand -hex 24` в терминале, скопируй
   - `USER_PERSONA` (опционально) — твой стиль
   - `REPLY_STYLE` (опционально)
   - `EXAMPLE_REPLIES` (опционально) — JSON-массив твоих реальных реплик
5. **Settings → Networking → Generate Domain** → получишь URL типа `https://bridge-xxx.up.railway.app`. Запомни его.
6. **Volumes → Add Volume → Mount Path `/app/data`** чтоб SQLite не терялся.

## Деплой на Render

1. Залей папку `bridge/` в GitHub-репо (включая `Dockerfile`).
2. https://render.com → **New → Web Service → Build from GitHub**.
3. Runtime: Docker. Free tier работает, но persistent disk только на платных — на бесплатном планe очередь живёт до рестарта.

## Деплой на VPS

```bash
cd bridge
npm install
BRIDGE_TOKEN=$(openssl rand -hex 24) \
TELEGRAM_BOT_TOKEN=... \
OPENROUTER_API_KEY=... \
PORT=8080 \
nohup node bridge.js &
```

Поставь за nginx/caddy с HTTPS для production.

## Env vars шпаргалка

| Var | Required | Default |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | **yes** | — |
| `OPENROUTER_API_KEY` | **yes** | — |
| `BRIDGE_TOKEN` | **yes** | random if missing (then extension can't connect!) |
| `MODEL` | no | `google/gemini-2.0-flash-exp:free` |
| `FALLBACK_MODELS` | no | `deepseek/deepseek-chat-v3:free,...` |
| `USER_PERSONA` | no | sensible default |
| `REPLY_STYLE` | no | sensible default |
| `EXAMPLE_REPLIES` | no | `[]` |
| `MAX_PER_HOUR` | no | `8` |
| `MAX_PER_DAY` | no | `30` |
| `MIN_DELAY_MS` | no | `90000` |
| `MAX_DELAY_MS` | no | `240000` |
| `PORT` | no | `8080` |
| `DATA_DIR` | no | `/app/data` |

## Локальный запуск для теста

```bash
cd bridge
npm install
cat > .env <<EOF
TELEGRAM_BOT_TOKEN=...
OPENROUTER_API_KEY=sk-or-v1-...
BRIDGE_TOKEN=$(openssl rand -hex 24)
EOF
# экспортируй переменные и запусти
node bridge.js
```