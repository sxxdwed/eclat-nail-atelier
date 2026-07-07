# Safe deployment checklist

## Before pushing to GitHub

1. Revoke every Telegram token previously pasted into chats and create a new token with BotFather.
2. Never copy `.env` or `data/booking-data.json` into Git.
3. Run `npm run check`.
4. Verify `git status --ignored` shows `.env` and `data/booking-data.json` as ignored.

## Render configuration

The included `render.yaml` creates one Node.js web service in Frankfurt with a persistent disk mounted at `/opt/render/project/src/data`.

Set these secret variables only in the Render Dashboard:

- `BOT_TOKEN`
- `CLIENT_BOT_TOKEN` — токен отдельного клиентского бота
- `OWNER_CHAT_ID`
- `ADMIN_PASSWORD` — at least 16 unique characters

Do not add `PORT`; Render supplies it automatically.

## After deployment

1. Open `/health` and verify `{ "ok": true }`.
2. Verify `/.env`, `/server.js`, and `/data/booking-data.json` return 404.
3. Submit one test booking, connect it to the client bot, and confirm it in the owner bot.
4. Restart the Render service and confirm the booking remains on the persistent disk.
5. Configure the Telegram Mini App URL as `https://YOUR-SERVICE.onrender.com/miniapp.html`.
