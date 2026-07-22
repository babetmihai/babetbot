# Babetbot

Telegram bot for professional-services client intake, payment, and provider relay. Ships with copy for law firms (`lawyers`) and psychologists (`psychologists`); generic defaults live in `base`.

Node · TypeScript · Express · Telegraf · LangGraph · Supabase (Postgres + pgvector) · OpenAI · Stripe.

## Client flow

1. Client messages the bot in a private DM. A LangGraph intake agent collects required goals, answers firm FAQ via RAG, and saves extra notes.
2. Intake goals are stored by the agent through `update_user_goal` only — no separate pre-agent extraction pipeline. Derived goals (e.g. `practice_area`) are inferred after `description` is saved.
3. When all required goals are complete (including `consent=yes`), the client pays a fixed intake fee via Stripe Checkout.
4. After payment, the bot broadcasts the case to all onboarded providers. The first provider to accept gets the client.
5. The bot opens a forum topic in the provider's private chat with the bot (Telegram Threaded Mode) and posts the intake summary.
6. Client messages and files stay in DM; the bot relays them to the provider's case topic. Provider replies in the topic are forwarded to the client DM.
7. When the provider runs `/close`, the case ends, the client is notified, and intake state is reset for a future case.

If no providers are onboarded, or all providers decline, admins are notified and the client gets a blocked/declined message.

## Provider flow

1. Register with `/join Your Name` in a private chat. Non-admin signups go to admins for approve/decline; admins are registered immediately.
2. Start the bot (`/start`) so the account is marked onboarded — only onboarded providers receive case offers.
3. Accept or decline incoming client offers via inline buttons.
4. Work in the case topic:
   - Reply in the topic to message the client.
   - `/pay <amount> <description>` — send the client a Stripe payment link.
   - `/analyze` — LLM summary of the conversation so far.
   - Tap **Analyze** on a relayed client file for a file summary.
   - Refund a client payment via the inline button on the payment notice in the topic.
   - `/close` — end the case.
   - `/delete` — remove the topic after the case is closed.

## Admin

- Upload firm FAQ PDFs to the bot in DM (admin Telegram IDs only). PDFs are chunked, embedded, and stored in Supabase for RAG.
- Approve or decline provider signup requests via inline buttons.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `update_user_goal` | Save intake goal values (`description`, `consent`, …) |
| `save_user_information` | Save extra intake notes not covered by goals |
| `user_information_retrieval` | Search firm FAQ + client notes/goals during intake |

Agent conversation state is checkpointed in Postgres (`SUPABASE_POSTGRES_URL`).

## Setup

1. Enable **Threaded Mode** for the bot in @BotFather.
2. Run `schemas/init.sql` in Supabase (tables, goal definitions, pgvector).
3. Copy `.env` from a teammate or create one from the env list below.
4. `npm install` then `npm start` — Express serves Telegram and Stripe webhooks via ngrok.
5. Local Stripe webhooks: set `STRIPE_DEV=1` and run `npm run stripe` in a second terminal.

## Templates

User-facing messages and LLM prompts live in `templates/` as `.txt` files with `{variable}` placeholders. Set `TEMPLATE_FOLDER` to `lawyers`, `psychologists`, or `base`. Folder-specific files override `base` when present.

## Env

Required at startup:

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Webhook secret header |
| `NGROK_AUTH_TOKEN` | Tunnel for local webhooks |
| `PORT` | Express port (default `8080`) |
| `OPENAI_API_KEY` | Agent, RAG embeddings, analysis |
| `SUPABASE_URL` / `SUPABASE_KEY` | Supabase client |
| `SUPABASE_POSTGRES_URL` | LangGraph checkpointer |
| `KB_USER_ID` | Vector-store user id for firm FAQ docs |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Payments |
| `INTAKE_FEE_AMOUNT_CENTS` | Fixed intake fee (e.g. `15000` = 150.00) |

Optional:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TEMPLATE_FOLDER` | `base` | Template override folder |
| `AGENT_MODEL` | `gpt-4o-mini` | Intake agent + analysis model |
| `STRIPE_DEV` | off | `1` = skip live Stripe webhook registration |
| `STRIPE_CURRENCY` | `ron` | Checkout currency |
| `ADMIN_TELEGRAM_IDS` | — | Comma-separated admin Telegram user ids |
