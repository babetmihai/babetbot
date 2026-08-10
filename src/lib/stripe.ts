import Stripe from "stripe"
import { fetchBotUsername } from "./telegram.ts"


const { STRIPE_SECRET_KEY } = process.env

export const stripe = new Stripe(STRIPE_SECRET_KEY)

const stripeWebhookEvents: Stripe.WebhookEndpointCreateParams.EnabledEvent[] = ["checkout.session.completed"]

export const disableStripeWebhook = async () => {
  const { data: endpoints } = await stripe.webhookEndpoints.list({ limit: 100 })
  const existing = endpoints.find((endpoint) => endpoint.metadata?.app === "babetbot")
  if (!existing || existing.status === "disabled") return

  await stripe.webhookEndpoints.update(existing.id, { disabled: true })
  console.log("Stripe webhook endpoint disabled for local CLI")
}

export const ensureStripeWebhook = async (webhookUrl) => {
  const { data: endpoints } = await stripe.webhookEndpoints.list({ limit: 100 })
  const existing = endpoints.find((endpoint) => endpoint.metadata?.app === "babetbot")

  if (existing) {
    const needsUpdate = existing.url !== webhookUrl || existing.status === "disabled"
    if (needsUpdate) {
      await stripe.webhookEndpoints.update(existing.id, {
        url: webhookUrl,
        enabled_events: stripeWebhookEvents,
        disabled: false
      })
      console.log(`Stripe webhook updated → ${webhookUrl}`)
    }
    return
  }

  const endpoint = await stripe.webhookEndpoints.create({
    url: webhookUrl,
    enabled_events: stripeWebhookEvents,
    metadata: { app: "babetbot" }
  })

  console.log(`Stripe webhook created → ${webhookUrl}`)
  console.log(`Set STRIPE_WEBHOOK_SECRET=${endpoint.secret}`)
}

export const createCheckoutSession = async ({
  clientTelegramId,
  clientChatId,
  caseId,
  amountCents,
  currency,
  description,
  kind
}) => {
  const botUsername = await fetchBotUsername()
  const botUrl = `https://t.me/${botUsername}`

  return stripe.checkout.sessions.create({
    mode: "payment",
    line_items: [{
      price_data: {
        currency,
        unit_amount: amountCents,
        product_data: { name: description }
      },
      quantity: 1
    }],
    metadata: {
      client_telegram_id: clientTelegramId,
      client_chat_id: String(clientChatId),
      kind,
      case_id: caseId ? String(caseId) : ""
    },
    success_url: botUrl,
    cancel_url: botUrl
  })
}
