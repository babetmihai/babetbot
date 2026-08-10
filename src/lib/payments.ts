import db from "./firestore.ts"
import { fetchProvider } from "./providers.ts"
import { renderTemplate } from "./templates.ts"
import { sendToTopic, telegram } from "./telegram.ts"
import {
  createProviderCheckoutSession,
  refundStripePayment,
  stripe
} from "./stripe.ts"


const { STRIPE_CURRENCY } = process.env
const stripeCurrency = STRIPE_CURRENCY.toLowerCase()

export type PaymentRecord = {
  id: string
  clientTelegramId: string
  clientChatId: number
  caseId: string | null
  stripeSessionId: string
  stripePaymentIntentId: string | null
  amountCents: number
  currency: string
  status: "pending" | "paid" | "refunded"
  kind: "provider_request"
  description: string
}


export const formatPaymentAmount = (amountCents, currency) => {
  const major = (amountCents / 100).toFixed(2)
  return `${major} ${currency.toUpperCase()}`
}

export const fetchPaymentById = async (paymentId) => {
  const doc = await db.collection("payments").doc(paymentId).get()
  if (!doc.exists) return null
  return mapPaymentDoc(doc)
}

export const createProviderPaymentRequest = async (caseRecord, provider, amountCents, description) => {
  const session = await createProviderCheckoutSession({
    clientTelegramId: caseRecord.clientTelegramId,
    clientChatId: caseRecord.clientChatId,
    caseId: caseRecord.id,
    amountCents,
    description
  })

  const ref = await db.collection("payments").add({
    clientTelegramId: caseRecord.clientTelegramId,
    clientChatId: caseRecord.clientChatId,
    caseId: caseRecord.id,
    stripeSessionId: session.id,
    stripePaymentIntentId: null,
    amountCents,
    currency: stripeCurrency,
    status: "pending",
    kind: "provider_request",
    description,
    createdAt: new Date().toISOString(),
    paidAt: null,
    refundedAt: null
  })

  const payment = await fetchPaymentById(ref.id)
  const amountLabel = formatPaymentAmount(amountCents, stripeCurrency)
  const descriptionLine = description ? `For: ${description}\n` : ""
  const clientText = renderTemplate("payment/provider-request", {
    providerName: provider.name,
    amountLabel,
    descriptionLine
  })

  await sendPaymentLink(caseRecord.clientChatId, clientText, session.url)

  return payment
}

export const sendPaymentLink = async (chatId, message, checkoutUrl) => {
  await telegram.sendMessage(chatId, message, {
    reply_markup: {
      inline_keyboard: [[{ text: "Pay with card", url: checkoutUrl }]]
    }
  })
}

export const completePaymentFromSession = async (session) => {
  const snapshot = await db.collection("payments")
    .where("stripeSessionId", "==", session.id)
    .limit(1)
    .get()

  if (snapshot.empty) return null

  const existingDoc = snapshot.docs[0]
  let payment = mapPaymentDoc(existingDoc)

  if (existingDoc.data().status === "paid") return payment
  if (existingDoc.data().status === "refunded") return payment

  const paymentIntentId = getPaymentIntentId(session)
  const paidAt = new Date().toISOString()

  const updated = await db.runTransaction(async (tx) => {
    const current = await tx.get(existingDoc.ref)
    if (!current.exists) return null
    if (current.data().status !== "pending") return null

    tx.update(existingDoc.ref, {
      status: "paid",
      paidAt,
      stripePaymentIntentId: paymentIntentId
    })

    return mapPaymentDoc(current)
  })

  if (!updated) {
    const refetched = await fetchPaymentById(existingDoc.id)
    if (!refetched || refetched.status !== "paid") return null
    return refetched
  }

  payment = {
    ...updated,
    status: "paid",
    stripePaymentIntentId: paymentIntentId
  }

  if (payment.kind === "provider_request") {
    await handlePaidProviderRequest(payment)
  }

  return payment
}

const handlePaidProviderRequest = async (payment) => {
  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)

  await telegram.sendMessage(
    payment.clientChatId,
    renderTemplate("payment/received-thanks", { amountLabel })
  )

  if (!payment.caseId) return

  const caseDoc = await db.collection("cases").doc(payment.caseId).get()
  if (!caseDoc.exists) return

  const data = caseDoc.data()
  await sendPaymentConfirmationToTopic(data.groupChatId, data.topicId, payment)
}

export const refundPaymentAsProvider = async (paymentId, providerTelegramUserId, caseRecord) => {
  const payment = await fetchPaymentById(paymentId)
  if (!payment) return { toast: "Payment not found." }

  const isClientPayment = payment.clientTelegramId === caseRecord.clientTelegramId
  const isCasePayment = payment.caseId === caseRecord.id
  if (!isClientPayment || !isCasePayment) {
    return { toast: "This payment is not for this case." }
  }

  const provider = await fetchProvider(caseRecord.providerId)
  if (!provider || provider.telegramUserId !== providerTelegramUserId) {
    return { toast: renderTemplate("bot/not-assigned-refund") }
  }

  if (payment.status !== "paid") {
    return { toast: "This payment cannot be refunded." }
  }

  let paymentIntentId = payment.stripePaymentIntentId
  if (!paymentIntentId) {
    const session = await retrieveCheckoutUrl(payment.stripeSessionId)
    paymentIntentId = getPaymentIntentId(session)
  }

  if (!paymentIntentId) {
    return { toast: "This payment cannot be refunded." }
  }

  await refundStripePayment(paymentIntentId)

  const paymentRef = db.collection("payments").doc(paymentId)
  const updated = await db.runTransaction(async (tx) => {
    const current = await tx.get(paymentRef)
    if (!current.exists) return null
    if (current.data().status !== "paid") return null

    tx.update(paymentRef, {
      status: "refunded",
      refundedAt: new Date().toISOString(),
      stripePaymentIntentId: paymentIntentId
    })

    return mapPaymentDoc(current)
  })

  if (!updated) return { toast: "This payment was already refunded." }

  const refunded = {
    ...updated,
    status: "refunded",
    stripePaymentIntentId: paymentIntentId
  }
  const amountLabel = formatPaymentAmount(refunded.amountCents, refunded.currency)

  await telegram.sendMessage(
    refunded.clientChatId,
    renderTemplate("payment/refunded-client", { amountLabel })
  )

  return {
    toast: "Payment refunded.",
    editText: buildRefundedConfirmationText(refunded)
  }
}

const sendPaymentConfirmationToTopic = async (groupChatId, topicId, payment) => {
  await sendToTopic(
    groupChatId,
    topicId,
    buildPaidConfirmationText(payment),
    { reply_markup: buildRefundKeyboard(payment.id) }
  )
}

const buildPaidConfirmationText = (payment) => {
  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
  const descriptionSuffix = payment.description ? ` — ${payment.description}` : ""
  return renderTemplate("payment/topic-paid-provider", { amountLabel, descriptionSuffix })
}

const buildRefundedConfirmationText = (payment) => {
  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
  const descriptionSuffix = payment.description ? ` — ${payment.description}` : ""
  return renderTemplate("payment/topic-refunded-provider", { amountLabel, descriptionSuffix })
}

const buildRefundKeyboard = (paymentId) => ({
  inline_keyboard: [[{ text: "Refund", callback_data: `refund:${paymentId}` }]]
})

const getPaymentIntentId = (session) => {
  const paymentIntent = session.payment_intent
  if (!paymentIntent) return null
  if (typeof paymentIntent === "string") return paymentIntent
  return paymentIntent.id
}

const retrieveCheckoutUrl = async (sessionId) =>
  stripe.checkout.sessions.retrieve(sessionId)

const mapPaymentDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    clientTelegramId: data.clientTelegramId,
    clientChatId: data.clientChatId,
    caseId: data.caseId ?? null,
    stripeSessionId: data.stripeSessionId,
    stripePaymentIntentId: data.stripePaymentIntentId ?? null,
    amountCents: data.amountCents,
    currency: data.currency,
    status: data.status,
    kind: data.kind,
    description: data.description
  }
}
