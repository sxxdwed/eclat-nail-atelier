# Safe deployment checklist

## Before pushing to GitHub

1. Revoke every Telegram token previously pasted into chats and create a new token with BotFather.
2. Never copy `.env` or `data/booking-data.json` into Git.
3. Run `npm run check`.
4. Verify `git status --ignored` shows `.env` and `data/booking-data.json` as ignored.

## Render configuration

The included `render.yaml` creates one free Node.js web service in Frankfurt. This portfolio configuration uses Render's ephemeral filesystem, so bookings and reviews can reset after a restart or redeploy.

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
4. Remember that the free portfolio deployment can sleep and reset locally stored booking data.
5. Configure the Telegram Mini App URL as `https://YOUR-SERVICE.onrender.com/miniapp.html`.
