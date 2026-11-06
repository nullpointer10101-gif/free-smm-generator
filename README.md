# Free SMM Generator

Autonomous TGPanel account generator service for [free-smm-bot](https://github.com/nullpointer10101-gif/-free-smm-bot).

## Features
- Headless Chromium with **Xvfb virtual display** in Docker
- **Buster: Captcha Solver for Humans** Chrome extension bundled
- Automatically solves reCAPTCHA audio challenges
- Registers fresh $0.01 accounts on `tgpanel.org`
- Directly injects fresh accounts into the main bot via `POST /api/add-accounts`
- Triggerable via HTTP API (`POST /generate`) or directly via Telegram (`/gen 10`)

## Environment Variables
- `PORT`: (default `3001` or provided by Railway)
- `GENERATOR_SECRET`: Shared secret key between the generator and main bot
- `BOT_API_URL`: URL of the main bot (e.g. `https://free-smm-bot.up.railway.app`)
- `BOT_TOKEN`: (optional) Telegram Bot token for direct progress notifications
- `ADMIN_CHAT_ID`: (optional) Your Telegram chat ID for progress notifications

## Endpoints
- `GET /` — Health status
- `POST /generate` `{ "secret": "...", "count": 10 }` — Start background generation
- `GET /status` — Current progress

