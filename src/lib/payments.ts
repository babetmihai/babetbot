import supabase from "./supabase.js"
import { INTAKE_FEE_AMOUNT_CENTS, STRIPE_CURRENCY } from "../config.js"
import { escalateToProvider, fetchActiveCase } from "./cases.js"
import { mergeUserGoals } from "./goals.js"
import { fetchProvider } from "./providers.js"
import { renderTemplate } from "./templates.js"
import { sendToTopic, telegram } from "./telegram.js"
import {
  createIntakeCheckoutSession,
  createProviderCheckoutSession,
  refundStripePayment,
  stripe
} from "./stripe.js"


export type PaymentRecord = {
  id: number
  clientTelegramId: string
  clientChatId: number
  caseId: number | null
  stripeSessionId: string
  stripePaymentIntentId: string | null
  amountCents: number
  currency: string
  status: "pending" | "paid" | "refunded"
  kind: "intake_fee" | "provider_request"
  description: string
}


const paymentSelect = "id, client_telegram_id, client_chat_id, case_id, stripe_session_id, stripe_payment_intent_id, amount_cents, currency, status, kind, description"

export const formatPaymentAmount = (amountCents, currency) => {
  const major = (amountCents / 100).toFixed(2)
  return `${major} ${currency.toUpperCase()}`
}

export const fetchPaidIntakeFee = async (clientTelegramId) => {
  const { data, error } = await supabase
    .from("payments")
    .select(paymentSelect)
    .eq("client_telegram_id", clientTelegramId)
    .eq("kind", "intake_fee")
    .eq("status", "paid")
    .is("case_id", null)
    .order("paid_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data ? mapRow(data) : null
}

export const linkIntakePaymentToCase = async (clientTelegramId, caseId) => {
  const { error } = await supabase
    .from("payments")
    .update({ case_id: caseId })
    .eq("client_telegram_id", clientTelegramId)
    .eq("kind", "intake_fee")
    .eq("status", "paid")
    .is("case_id", null)

  if (error) throw error
}

export const fetchPendingIntakePayment = async (clientTelegramId) => {
  const { data, error } = await supabase
    .from("payments")
    .select(paymentSelect)
    .eq("client_telegram_id", clientTelegramId)
    .eq("kind", "intake_fee")
    .eq("status", "pending")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data ? mapRow(data) : null
}

export const fetchPaymentById = async (paymentId) => {
  const { data, error } = await supabase
    .from("payments")
    .select(paymentSelect)
    .eq("id", paymentId)
    .maybeSingle()

  if (error) throw error
  return data ? mapRow(data) : null
}

export const requestIntakePayment = async (clientTelegramId, clientChatId) => {
  const pending = await fetchPendingIntakePayment(clientTelegramId)
  if (pending) {
    const session = await retrieveCheckoutUrl(pending.stripeSessionId)
    if (session.url) {
      return { payment: pending, checkoutUrl: session.url }
    }
  }

  const session = await createIntakeCheckoutSession(clientTelegramId, clientChatId)
  const { data, error } = await supabase
    .from("payments")
    .insert({
      client_telegram_id: clientTelegramId,
      client_chat_id: clientChatId,
      case_id: null,
      stripe_session_id: session.id,
      amount_cents: INTAKE_FEE_AMOUNT_CENTS,
      currency: STRIPE_CURRENCY,
      status: "pending",
      kind: "intake_fee",
      description: "Intake fee"
    })
    .select(paymentSelect)
    .single()

  if (error) throw error
  return { payment: mapRow(data), checkoutUrl: session.url }
}

export const createProviderPaymentRequest = async (caseRecord, provider, amountCents, description) => {
  const session = await createProviderCheckoutSession({
    clientTelegramId: caseRecord.clientTelegramId,
    clientChatId: caseRecord.clientChatId,
    caseId: caseRecord.id,
    amountCents,
    description
  })

  const { data, error } = await supabase
    .from("payments")
    .insert({
      client_telegram_id: caseRecord.clientTelegramId,
      client_chat_id: caseRecord.clientChatId,
      case_id: caseRecord.id,
      stripe_session_id: session.id,
      amount_cents: amountCents,
      currency: STRIPE_CURRENCY,
      status: "pending",
      kind: "provider_request",
      description
    })
    .select(paymentSelect)
    .single()

  if (error) throw error

  const payment = mapRow(data)
  const amountLabel = formatPaymentAmount(amountCents, STRIPE_CURRENCY)
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
  const { data: existing, error: fetchError } = await supabase
    .from("payments")
    .select(paymentSelect)
    .eq("stripe_session_id", session.id)
    .maybeSingle()

  if (fetchError) throw fetchError
  if (!existing) return null

  let payment = mapRow(existing)

  if (existing.status === "paid") {
    if (payment.kind === "intake_fee") {
      await handlePaidIntakeFee(payment)
    }
    return payment
  }

  if (existing.status === "refunded") return payment

  const paymentIntentId = getPaymentIntentId(session)

  const { data: updated, error } = await supabase
    .from("payments")
    .update({
      status: "paid",
      paid_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId
    })
    .eq("stripe_session_id", session.id)
    .eq("status", "pending")
    .select(paymentSelect)
    .maybeSingle()

  if (error) throw error

  if (!updated) {
    const { data: refetched, error: refetchError } = await supabase
      .from("payments")
      .select(paymentSelect)
      .eq("stripe_session_id", session.id)
      .maybeSingle()

    if (refetchError) throw refetchError
    if (!refetched || refetched.status !== "paid") return null

    payment = mapRow(refetched)
    if (payment.kind === "intake_fee") {
      await handlePaidIntakeFee(payment)
    }
    return payment
  }

  payment = mapRow(updated)

  if (payment.kind === "intake_fee") {
    await handlePaidIntakeFee(payment)
  }

  if (payment.kind === "provider_request") {
    await handlePaidProviderRequest(payment)
  }

  return payment
}

const handlePaidIntakeFee = async (payment) => {
  const activeCase = await fetchActiveCase(payment.clientTelegramId)
  if (activeCase) return

  const userGoals = await mergeUserGoals(payment.clientTelegramId)

  try {
    const clientMessage = await escalateToProvider(
      payment.clientTelegramId,
      payment.clientChatId,
      userGoals
    )

    const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
    await telegram.sendMessage(
      payment.clientChatId,
      renderTemplate("payment/received-with-message", { amountLabel, clientMessage })
    )
  } catch (error) {
    const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
    await telegram.sendMessage(
      payment.clientChatId,
      renderTemplate("payment/received-with-error", { amountLabel, errorMessage: error.message })
    )
  }
}

const handlePaidProviderRequest = async (payment) => {
  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)

  await telegram.sendMessage(
    payment.clientChatId,
    renderTemplate("payment/received-thanks", { amountLabel })
  )

  if (!payment.caseId) return

  const { data: caseRow, error } = await supabase
    .from("cases")
    .select("group_chat_id, topic_id")
    .eq("id", payment.caseId)
    .maybeSingle()

  if (error) throw error
  if (!caseRow) return

  await sendPaymentConfirmationToTopic(caseRow.group_chat_id, caseRow.topic_id, payment)
}

export const notifyPaidIntakeFeeInTopic = async (caseRecord) => {
  const payment = await fetchPaidIntakeFee(caseRecord.clientTelegramId)
  if (!payment) return

  await sendPaymentConfirmationToTopic(caseRecord.groupChatId, caseRecord.topicId, payment)
}

export const refundPaymentAsProvider = async (paymentId, providerTelegramUserId, caseRecord) => {
  const payment = await fetchPaymentById(paymentId)
  if (!payment) return { toast: "Payment not found." }

  const isClientPayment = payment.clientTelegramId === caseRecord.clientTelegramId
  const isCasePayment = payment.caseId === caseRecord.id
  if (!isClientPayment || (payment.kind === "provider_request" && !isCasePayment)) {
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

  const { data: updated, error } = await supabase
    .from("payments")
    .update({
      status: "refunded",
      refunded_at: new Date().toISOString(),
      stripe_payment_intent_id: paymentIntentId
    })
    .eq("id", paymentId)
    .eq("status", "paid")
    .select(paymentSelect)
    .maybeSingle()

  if (error) throw error
  if (!updated) return { toast: "This payment was already refunded." }

  const refunded = mapRow(updated)
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
  const isIntakeFee = payment.kind === "intake_fee"

  if (isIntakeFee) {
    return renderTemplate("payment/topic-paid-intake", { amountLabel })
  }

  const descriptionSuffix = payment.description ? ` — ${payment.description}` : ""
  return renderTemplate("payment/topic-paid-provider", { amountLabel, descriptionSuffix })
}

const buildRefundedConfirmationText = (payment) => {
  const amountLabel = formatPaymentAmount(payment.amountCents, payment.currency)
  const isIntakeFee = payment.kind === "intake_fee"

  if (isIntakeFee) {
    return renderTemplate("payment/topic-refunded-intake", { amountLabel })
  }

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

const mapRow = (row) => ({
  id: row.id,
  clientTelegramId: row.client_telegram_id,
  clientChatId: row.client_chat_id,
  caseId: row.case_id,
  stripeSessionId: row.stripe_session_id,
  stripePaymentIntentId: row.stripe_payment_intent_id,
  amountCents: row.amount_cents,
  currency: row.currency,
  status: row.status,
  kind: row.kind,
  description: row.description
})
