# Babetbot

Telegram bot for professional-services client intake and provider relay. Ships with copy for law firms (`lawyers`) and psychologists (`psychologists`); generic defaults live in `base`.

Node · TypeScript · Express · Telegraf · LangGraph · Firestore · OpenAI · Stripe.

## Client flow

1. Client messages the bot in a private DM. A LangGraph intake agent collects required goals, answers firm FAQ via RAG, and saves extra notes.
2. Intake goals are stored by the agent through `update_user_goal` only — no separate pre-agent extraction pipeline. Derived goals (e.g. `practice_area`) are inferred from the client discussion via `llm/infer-{goalKey}` templates.
3. When all required goals are complete (including `consent=yes`), the bot broadcasts the case to all onboarded providers. The first provider to accept gets the client.
4. The bot opens a forum topic in the provider's private chat with the bot (Telegram Threaded Mode) and posts the intake summary.
5. Client messages and files stay in DM; the bot relays them to the provider's case topic. Provider replies in the topic are forwarded to the client DM.
6. When the provider runs `/close`, the case ends, the client is notified, and intake state is reset for a future case.

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

- Upload firm FAQ PDFs to the bot in DM (admin Telegram IDs only). PDFs are chunked, embedded, and stored in Firestore for RAG.
- Approve or decline provider signup requests via inline buttons.

## Agent tools

| Tool | Purpose |
| --- | --- |
| `update_user_goal` | Save intake goal values (`description`, `consent`, …) |
| `save_user_information` | Save extra intake notes not covered by goals |
| `user_information_retrieval` | Search firm FAQ + client notes/goals during intake |

Agent conversation state is checkpointed in Firestore (`agent_checkpoints` / `agent_writes`). Goal definitions live in `templates/{folder}/goals/definitions.json` (falls back to `base`); per-goal agent wording is in `templates/{folder}/goals/{key}.txt`.

## Firestore

Standard edition, Native mode. Auth via ADC or `GOOGLE_APPLICATION_CREDENTIALS`; set `FIREBASE_PROJECT_ID` in `.env`.

### Collections

| Collection | Purpose |
| --- | --- |
| `user_goal_values` | Per-client intake answers (`userId`, `goalKey`, `value`) |
| `providers` | Registered providers |
| `provider_signup_requests` | Admin approve/decline queue |
| `provider_case_offer_batches` | Broadcast offer batches |
| `provider_case_offer_batches/{id}/messages` | Per-provider offer Telegram messages |
| `intake_block_notifications` | Dedupe admin alerts when intake is blocked |
| `cases` | Active/closed client ↔ provider cases |
| `payments` | Stripe checkout rows |
| `documents` | RAG chunks + vector embeddings |
| `agent_checkpoints` | LangGraph thread checkpoints |
| `agent_writes` | LangGraph pending writes |

### Vector indexes

Create a vector index on `documents.embedding` (dimension **1536**, distance **COSINE**), plus composites for RAG pre-filters (`user_id`, and `user_id` + `scope`):

```bash
gcloud firestore indexes composite create \
  --collection-group=documents \
  --query-scope=COLLECTION \
  --field-config field-path=user_id,order=ASCENDING \
  --field-config field-path=embedding,vector-config='{"dimension":"1536","flat": "{}"}' \
  --database='(default)'
```

Or use the console link when a query fails for a missing index.

### Composite indexes

Create as prompted by Firestore when running the app, including roughly:

- `cases`: `clientTelegramId` + `status` + `createdAt`
- `cases`: `groupChatId` + `topicId` + `status`
- `provider_case_offer_batches`: `clientTelegramId` + `status`
- `payments`: `clientTelegramId` + `kind` + `status` + `caseId` + `paidAt`
- `payments`: `clientTelegramId` + `kind` + `status` + `createdAt`
- `documents`: `user_id` + `created_at`
- `documents`: `user_id` + `type` + `created_at`
- `documents`: `user_id` + `type` + `goal_key`
- `documents`: `user_id` + `scope`
- `agent_checkpoints`: `threadId` + `checkpointNs` + `checkpointId`
- `agent_checkpoints`: `threadId` + `checkpointId`
- `agent_writes`: `threadId` + `checkpointNs` + `checkpointId`

Single-field equality lookups (`providers.telegramUserId`, `payments.stripeSessionId`, `user_goal_values.userId`, …) are automatic.

## Setup

1. Enable **Threaded Mode** for the bot in @BotFather.
2. Create a Firestore **Standard** (Native mode) database and create the indexes above.
3. Copy `.env` from a teammate or create one from the env list below. Authenticate with ADC or `GOOGLE_APPLICATION_CREDENTIALS`.
4. `npm install` then `npm start` — local Express + ngrok + Stripe CLI forwarding.

## Production (Firebase Functions)

Same Express app as local. Local entry is `src/start.ts` (ngrok + `app.listen`); production entry is `src/deploy.ts` (`onRequest`, Node 22 type-stripping — no `dist/` build).

1. `npm install` and `firebase login`
2. Set function env/secrets in Firebase (same vars as `.env`)
3. `npm run deploy` — deploys the `api` function and registers Telegram/Stripe webhooks to
`https://europe-west1-{project}.cloudfunctions.net/api`.

## Templates

User-facing messages and LLM prompts live in `templates/` as `.txt` files with `{variable}` placeholders. Set `TEMPLATE_FOLDER` to `lawyers`, `psychologists`, or `base`. Folder-specific files override `base` when present.

## Env

No silent defaults in code — set every value the process reads. See `.env.example`.

| Variable | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Bot token from @BotFather |
| `TELEGRAM_SECRET_TOKEN` | Webhook secret header |
| `ADMIN_TELEGRAM_IDS` | Comma-separated admin Telegram user ids |
| `OPENAI_API_KEY` | Agent, RAG embeddings, analysis |
| `AGENT_MODEL` | Intake agent + analysis model |
| `FIREBASE_PROJECT_ID` | Firebase / Firestore project |
| `KB_USER_ID` | Vector-store user id for firm FAQ docs |
| `TEMPLATE_FOLDER` | Template override folder (`lawyers`, `psychologists`, or `base`) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Payments |
| `STRIPE_CURRENCY` | Checkout currency (e.g. `ron`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to Firebase service-account JSON (local; or use ADC) |
| `NGROK_AUTH_TOKEN` | Tunnel for local webhooks |
| `PORT` | Express port (local) |
