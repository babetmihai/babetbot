import { onInit } from "firebase-functions/v2/core"
import { onRequest } from "firebase-functions/v2/https"
import app, { registerTelegramWebhook, STRIPE_WEBHOOK_PATH } from "./app.ts"
import { ensureStripeWebhook } from "./lib/stripe.ts"


const { FIREBASE_PROJECT_ID } = process.env
const FUNCTION_REGION = "europe-west1"
const FUNCTION_NAME = "api"
const FUNCTION_BASE_URL = `https://${FUNCTION_REGION}-${FIREBASE_PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}`
const STRIPE_WEBHOOK_URL = `${FUNCTION_BASE_URL}${STRIPE_WEBHOOK_PATH}`

onInit(async () => {
  const botUrl = await registerTelegramWebhook(FUNCTION_BASE_URL)
  await ensureStripeWebhook(STRIPE_WEBHOOK_URL)
  console.log(`Bot webhook → ${botUrl}`)
  console.log(`Stripe webhook → ${STRIPE_WEBHOOK_URL}`)
})

export const api = onRequest({
  region: FUNCTION_REGION,
  memory: "1GiB",
  timeoutSeconds: 300,
  invoker: "public"
}, app)
