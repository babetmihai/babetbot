import express from "express"
import bot, { BOT_WEBHOOK_PATH } from "./bot/index.ts"
import { completePaymentFromSession } from "./lib/payments.ts"
import { stripe, STRIPE_WEBHOOK_PATH } from "./lib/stripe.ts"


const {
  TELEGRAM_SECRET_TOKEN,
  STRIPE_WEBHOOK_SECRET
} = process.env

const app = express()

app.post(STRIPE_WEBHOOK_PATH, express.raw({ type: "application/json" }), async (req, res) => {
  const signature = req.headers["stripe-signature"]
  if (!signature || typeof signature !== "string") {
    return res.sendStatus(400)
  }

  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      signature,
      STRIPE_WEBHOOK_SECRET
    )

    if (event.type === "checkout.session.completed") {
      await completePaymentFromSession(event.data.object)
    }

    res.sendStatus(200)
  } catch (error) {
    console.error("Stripe webhook error:", error)
    res.sendStatus(400)
  }
})

app.use(BOT_WEBHOOK_PATH, (req, res, next) => {
  const secretToken = req.headers["x-telegram-bot-api-secret-token"]
  if (secretToken !== TELEGRAM_SECRET_TOKEN) {
    console.log("Invalid secret token")
    return res.sendStatus(401)
  }
  next()
})

app.use(bot.webhookCallback(BOT_WEBHOOK_PATH))

app.use((error, req, res, next) => {
  console.error(error)
  if (res.headersSent) return
  res.status(500).json({ message: "Something went wrong." })
})

export default app
