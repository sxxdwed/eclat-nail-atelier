# Security

## Secrets

Never commit `.env`, Telegram bot tokens, administrator passwords, client data or `data/booking-data.json`.

Configure production secrets through the hosting provider's environment-variable settings. If a token is exposed in chat, logs or Git history, revoke it immediately through BotFather and issue a new one.

## Reporting

If you discover a vulnerability, report it privately to the project owner. Do not include client names, phone numbers, tokens or passwords in public issues.
