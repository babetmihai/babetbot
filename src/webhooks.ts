import bot from "./bot/index.ts"
import { botPath, stripeWebhookPath } from "./app.ts"
import { STRIPE_DEV, TELEGRAM_SECRET_TOKEN } from "./config.ts"
import { disableStripeWebhook, ensureStripeWebhook } from "./lib/stripe.ts"


export const registerWebhooks = async (baseUrl) => {
  const botUrl = `${baseUrl}${botPath}`
  const stripeWebhookUrl = `${baseUrl}${stripeWebhookPath}`

  await bot.telegram.setWebhook(botUrl, {
    secret_token: TELEGRAM_SECRET_TOKEN
  })

  if (STRIPE_DEV) {
    await disableStripeWebhook()
  } else {
    await ensureStripeWebhook(stripeWebhookUrl)
  }

  return { botUrl, stripeWebhookUrl }
}
