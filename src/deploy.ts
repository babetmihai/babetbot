import "dotenv/config"
import { onRequest } from "firebase-functions/v2/https"
import app from "./app.ts"
import { registerTelegramWebhook } from "./bot/index.ts"
import { ensureStripeWebhook } from "./lib/stripe.ts"


const { FIREBASE_PROJECT_ID } = process.env
const FUNCTION_REGION = "europe-west1"
const FUNCTION_NAME = "api"
const FUNCTION_BASE_URL = `https://${FUNCTION_REGION}-${FIREBASE_PROJECT_ID}.cloudfunctions.net/${FUNCTION_NAME}`

export const api = onRequest({
  region: FUNCTION_REGION,
  memory: "1GiB",
  timeoutSeconds: 300,
  invoker: "public"
}, app)

const registerWebhooks = async () => {
  try {
    const botUrl = await registerTelegramWebhook(FUNCTION_BASE_URL)
    const stripeUrl = await ensureStripeWebhook(FUNCTION_BASE_URL)
    console.log(`Bot webhook → ${botUrl}`)
    console.log(`Stripe webhook → ${stripeUrl}`)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
}

const isRegister = process.argv.includes("--register")
if (isRegister) {
  registerWebhooks()
}
