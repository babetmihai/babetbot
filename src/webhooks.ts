import bot from "./bot/index.js"
import { botPath, stripeWebhookPath } from "./app.js"
import { STRIPE_DEV, TELEGRAM_SECRET_TOKEN } from "./config.js"
import { disableStripeWebhook, ensureStripeWebhook } from "./lib/stripe.js"


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
