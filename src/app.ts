import express from "express"
import bot from "./bot/index.js"
import { TELEGRAM_SECRET_TOKEN } from "./config.js"
import { completePaymentFromSession } from "./lib/payments.js"
import { verifyStripeWebhook } from "./lib/stripe.js"


export const botPath = "/bot/webhook"
export const stripeWebhookPath = "/stripe/webhook"

const app = express()

app.post(stripeWebhookPath, express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"]
  if (!signature || typeof signature !== "string") {
    return res.sendStatus(400)
  }

  try {
    const event = verifyStripeWebhook(getWebhookPayload(req), signature)

    if (event.type === "checkout.session.completed") {
      await completePaymentFromSession(event.data.object)
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Stripe webhook error:", error)
    res.sendStatus(400)
  }
})

app.use(botPath, (req, res, next) => {
  const secretToken = req.headers["x-telegram-bot-api-secret-token"]
  if (secretToken !== TELEGRAM_SECRET_TOKEN) {
    console.log("Invalid secret token")
    return res.sendStatus(401)
  }
  next()
})

app.use(bot.webhookCallback(botPath))

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return
  res.status(500).json({ message: error.message })
})

export default app

const getWebhookPayload = (req) => req.rawBody || req.body
