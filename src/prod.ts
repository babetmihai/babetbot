import { onInit } from "firebase-functions/v2/core"
import { onRequest } from "firebase-functions/v2/https"
import app, { registerTelegramWebhook, stripeWebhookPath } from "./app.ts"
import { FIREBASE_PROJECT_ID, PUBLIC_BASE_URL } from "./config.ts"
import { ensureStripeWebhook } from "./lib/stripe.ts"


const FUNCTION_REGION = "europe-west1"
const FUNCTION_NAME = "api"

const getFunctionBaseUrl = () => {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL

  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || FIREBASE_PROJECT_ID
  return `https://${FUNCTION_REGION}-${projectId}.cloudfunctions.net/${FUNCTION_NAME}`
}

onInit(async () => {
  const baseUrl = getFunctionBaseUrl()
  const botUrl = await registerTelegramWebhook(baseUrl)
  const stripeWebhookUrl = `${baseUrl}${stripeWebhookPath}`
  await ensureStripeWebhook(stripeWebhookUrl)
  console.log(`Bot webhook → ${botUrl}`)
  console.log(`Stripe webhook → ${stripeWebhookUrl}`)
})

export const api = onRequest({
  region: FUNCTION_REGION,
  memory: "1GiB",
  timeoutSeconds: 300,
  invoker: "public"
}, app)
