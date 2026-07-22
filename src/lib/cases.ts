import supabase from "./supabase.js"
import { ADMIN_TELEGRAM_IDS } from "../config.js"
import { resetAgentThread } from "./checkpointer.js"
import {
  areIntakeGoalsComplete,
  buildIntakeSummary,
  formatGoalContextForTools,
  getRequiredIntakeGoals,
  mergeUserGoals,
  resetClientIntake
} from "./goals.js"
import {
  fetchProvider,
  fetchProviderByTelegramUserId,
  fetchOnboardedProviders
} from "./providers.js"
import { renderTemplate } from "./templates.js"
import {
  closeForumTopic,
  createForumTopic,
  deleteForumTopic,
  editForumTopic,
  sendToTopic,
  telegram
} from "./telegram.js"


export type CaseRecord = {
  id: number
  clientTelegramId: string
  clientChatId: number
  providerId: number
  groupChatId: number
  topicId: number
  status: "active" | "closed"
  intakeSummary: string | null
}

const notifiedIntakeBlocks = new Set()

const caseSelect = "id, client_telegram_id, client_chat_id, provider_id, group_chat_id, topic_id, status, intake_summary"
const batchSelect = "id, client_telegram_id, client_chat_id, status, accepted_provider_id"
const offerMessageSelect = "id, batch_id, provider_id, chat_id, message_id, status"


export const fetchActiveCase = async (clientTelegramId) => {
  const { data, error } = await supabase
    .from("cases")
    .select(caseSelect)
    .eq("client_telegram_id", clientTelegramId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) throw error
  return data ? mapCaseRow(data) : null
}

export const fetchActiveCaseInTopic = async (groupChatId, topicId) => {
  const { data, error } = await supabase
    .from("cases")
    .select(caseSelect)
    .eq("group_chat_id", groupChatId)
    .eq("topic_id", topicId)
    .eq("status", "active")
    .maybeSingle()

  if (error) throw error
  return data ? mapCaseRow(data) : null
}

export const fetchClosedCaseInTopic = async (groupChatId, topicId) => {
  const { data, error } = await supabase
    .from("cases")
    .select(caseSelect)
    .eq("group_chat_id", groupChatId)
    .eq("topic_id", topicId)
    .eq("status", "closed")
    .maybeSingle()

  if (error) throw error
  return data ? mapCaseRow(data) : null
}

export const fetchPendingOfferBatch = async (clientTelegramId) => {
  const { data, error } = await supabase
    .from("provider_case_offer_batches")
    .select(batchSelect)
    .eq("client_telegram_id", clientTelegramId)
    .eq("status", "pending")
    .maybeSingle()

  if (error) throw error
  return data ? mapBatchRow(data) : null
}

export const isReadyForEscalation = (userGoals) => {
  const keys = getRequiredIntakeGoals(userGoals).map((goal) => goal.key)
  return areIntakeGoalsComplete(userGoals, keys)
}

export const getIntakeProviderAvailability = async () => {
  const availableProviders = await fetchOnboardedProviders()

  if (!availableProviders.length) {
    return {
      canCompleteIntake: false,
      reason: "no_provider",
      availableProviders
    }
  }

  return {
    canCompleteIntake: true,
    reason: null,
    availableProviders
  }
}

export const buildIntakeBlockedClientMessage = () =>
  renderTemplate("client/intake-blocked")

export const notifyIntakeProviderBlocked = async (clientTelegramId, userGoals, availability) => {
  const key = `${clientTelegramId}:${availability.reason}`
  if (notifiedIntakeBlocks.has(key)) return
  notifiedIntakeBlocks.add(key)

  await notifyFirmIntakeIssue(userGoals, renderTemplate("admin/intake-no-provider", {
    intakeSummary: buildIntakeSummary(userGoals)
  }))
}

export const closeCase = async (caseId) => {
  const { data, error } = await supabase
    .from("cases")
    .update({ status: "closed", closed_at: new Date().toISOString() })
    .eq("id", caseId)
    .select(caseSelect)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const caseRecord = mapCaseRow(data)

  await telegram.sendMessage(
    Number(caseRecord.clientTelegramId),
    renderTemplate("client/case-closed")
  )

  try {
    await resetClientIntake(caseRecord.clientTelegramId)
  } catch (error) {
    console.error("resetClientIntake error", caseRecord.clientTelegramId, error.message)
  }

  try {
    await resetAgentThread(caseRecord.clientTelegramId)
  } catch (error) {
    console.error("resetAgentThread error", caseRecord.clientTelegramId, error.message)
  }

  await sendToTopic(
    caseRecord.groupChatId,
    caseRecord.topicId,
    renderTemplate("provider/case-closed-topic")
  )
  await editForumTopic(caseRecord.groupChatId, caseRecord.topicId, buildCaseTopicName(caseRecord.id, true))

  const isSupergroupForum = caseRecord.groupChatId < 0
  if (isSupergroupForum) {
    await closeForumTopic(caseRecord.groupChatId, caseRecord.topicId)
  }

  return caseRecord
}

export const deleteClosedCaseTopic = async (caseRecord) => {
  await deleteForumTopic(caseRecord.groupChatId, caseRecord.topicId)
}

export const escalateToProvider = async (clientTelegramId, clientChatId, userGoals) => {
  const existing = await fetchActiveCase(clientTelegramId)
  if (existing) {
    const provider = await fetchProvider(existing.providerId)
    if (!provider) throw new Error("Assigned provider not found")
    return renderTemplate("client/already-connected", { providerName: provider.name })
  }

  const pendingBatch = await fetchPendingOfferBatch(clientTelegramId)
  if (pendingBatch) {
    return renderTemplate("client/waiting-for-provider")
  }

  return startProviderOfferBatch(clientTelegramId, clientChatId, userGoals)
}

export const respondToProviderOffer = async (batchId, providerTelegramUserId, action) => {
  switch (action) {
    case "accept":
      return acceptProviderOffer(batchId, providerTelegramUserId)
    case "decline":
      return declineProviderOffer(batchId, providerTelegramUserId)
    default:
      return { toast: "Unknown action." }
  }
}

const startProviderOfferBatch = async (clientTelegramId, clientChatId, userGoals) => {
  const availability = await getIntakeProviderAvailability()
  if (!availability.canCompleteIntake) {
    await notifyIntakeProviderBlocked(clientTelegramId, userGoals, availability)
    throw new Error(buildIntakeBlockedClientMessage())
  }

  const { availableProviders } = availability

  const { data: batchRow, error: batchError } = await supabase
    .from("provider_case_offer_batches")
    .insert({
      client_telegram_id: clientTelegramId,
      client_chat_id: clientChatId,
      status: "pending"
    })
    .select(batchSelect)
    .single()

  if (batchError) {
    if (batchError.code === "23505") {
      return renderTemplate("client/waiting-for-provider")
    }
    throw batchError
  }

  const batch = mapBatchRow(batchRow)
  const offerText = buildProviderOfferText(userGoals)

  for (const provider of availableProviders) {
    const chatId = Number(provider.telegramUserId)
    const sent = await telegram.sendMessage(chatId, offerText, {
      reply_markup: {
        inline_keyboard: [[
          { text: "Accept client", callback_data: `poffer:${batch.id}:accept` },
          { text: "Decline", callback_data: `poffer:${batch.id}:decline` }
        ]]
      }
    })

    await supabase
      .from("provider_case_offer_messages")
      .insert({
        batch_id: batch.id,
        provider_id: provider.id,
        chat_id: chatId,
        message_id: sent.message_id,
        status: "pending"
      })
  }

  return renderTemplate("client/waiting-for-provider")
}

const acceptProviderOffer = async (batchId, providerTelegramUserId) => {
  const provider = await fetchProviderByTelegramUserId(providerTelegramUserId)
  if (!provider || !provider.botStartedAt) {
    return { toast: renderTemplate("bot/not-onboarded") }
  }

  const { data: offerMessage, error: offerError } = await supabase
    .from("provider_case_offer_messages")
    .select(offerMessageSelect)
    .eq("batch_id", batchId)
    .eq("provider_id", provider.id)
    .maybeSingle()

  if (offerError) throw offerError
  if (!offerMessage) {
    return { toast: "This offer is not for you." }
  }

  const { data: claimed, error: claimError } = await supabase
    .from("provider_case_offer_batches")
    .update({
      status: "accepted",
      accepted_provider_id: provider.id,
      accepted_at: new Date().toISOString()
    })
    .eq("id", batchId)
    .eq("status", "pending")
    .select(batchSelect)
    .maybeSingle()

  if (claimError) throw claimError

  if (!claimed) {
    await dismissOfferMessage(offerMessage.chat_id, offerMessage.message_id)
    return { toast: "This case was already taken." }
  }

  const batch = mapBatchRow(claimed)
  const userGoals = await mergeUserGoals(batch.clientTelegramId)
  const { clientMessage } = await finalizeAcceptedCase(
    batch.clientTelegramId,
    batch.clientChatId,
    userGoals,
    provider
  )

  await supabase
    .from("provider_case_offer_messages")
    .update({ status: "accepted" })
    .eq("id", offerMessage.id)

  await dismissOtherOfferMessages(batchId, provider.id)
  await dismissOfferMessage(offerMessage.chat_id, offerMessage.message_id)

  await telegram.sendMessage(batch.clientChatId, clientMessage)

  return { toast: "Case accepted." }
}

const declineProviderOffer = async (batchId, providerTelegramUserId) => {
  const provider = await fetchProviderByTelegramUserId(providerTelegramUserId)
  if (!provider) {
    return { toast: renderTemplate("bot/not-registered") }
  }

  const { data: batch, error: batchError } = await supabase
    .from("provider_case_offer_batches")
    .select(batchSelect)
    .eq("id", batchId)
    .maybeSingle()

  if (batchError) throw batchError
  if (!batch || batch.status !== "pending") {
    return { toast: "This offer is no longer available." }
  }

  const { data: offerMessage, error: offerError } = await supabase
    .from("provider_case_offer_messages")
    .select(offerMessageSelect)
    .eq("batch_id", batchId)
    .eq("provider_id", provider.id)
    .maybeSingle()

  if (offerError) throw offerError
  if (!offerMessage || offerMessage.status !== "pending") {
    return { toast: "This offer is not for you." }
  }

  await supabase
    .from("provider_case_offer_messages")
    .update({ status: "declined" })
    .eq("id", offerMessage.id)

  await dismissOfferMessage(offerMessage.chat_id, offerMessage.message_id)

  const { data: remaining, error: remainingError } = await supabase
    .from("provider_case_offer_messages")
    .select("id")
    .eq("batch_id", batchId)
    .eq("status", "pending")

  if (remainingError) throw remainingError

  if (!remaining.length) {
    await supabase
      .from("provider_case_offer_batches")
      .update({ status: "exhausted" })
      .eq("id", batchId)
      .eq("status", "pending")

    const userGoals = await mergeUserGoals(batch.client_telegram_id)
    await notifyFirmIntakeIssue(userGoals, renderTemplate("admin/all-declined", {
      intakeSummary: buildIntakeSummary(userGoals)
    }))

    await telegram.sendMessage(
      batch.client_chat_id,
      renderTemplate("client/all-declined")
    )
  }

  return { toast: "Case declined." }
}

const finalizeAcceptedCase = async (clientTelegramId, clientChatId, userGoals, provider) => {
  const providerChatId = Number(provider.telegramUserId)
  const topicId = await createForumTopic(providerChatId, "New case")
  const intakeSummary = buildIntakeSummary(userGoals)

  const { data, error } = await supabase
    .from("cases")
    .insert({
      client_telegram_id: clientTelegramId,
      client_chat_id: clientChatId,
      provider_id: provider.id,
      group_chat_id: providerChatId,
      topic_id: topicId,
      status: "active",
      intake_summary: intakeSummary
    })
    .select(caseSelect)
    .single()

  if (error) {
    if (error.code === "23505") {
      const racedCase = await fetchActiveCase(clientTelegramId)
      if (!racedCase) throw error
      const { linkIntakePaymentToCase } = await import("./payments.js")
      await linkIntakePaymentToCase(clientTelegramId, racedCase.id)
      return {
        caseRecord: racedCase,
        clientMessage: buildConnectedClientMessage(provider)
      }
    }
    throw error
  }

  const caseRecord = mapCaseRow(data)
  await editForumTopic(providerChatId, topicId, buildCaseTopicName(caseRecord.id))
  await sendToTopic(providerChatId, topicId, intakeSummary)
  await sendToTopic(providerChatId, topicId, renderTemplate("provider/topic-opening"))

  const { linkIntakePaymentToCase, notifyPaidIntakeFeeInTopic } = await import("./payments.js")
  await notifyPaidIntakeFeeInTopic(caseRecord)
  await linkIntakePaymentToCase(clientTelegramId, caseRecord.id)

  console.log("[cases] accepted", {
    caseId: caseRecord.id,
    clientTelegramId,
    provider: provider.name,
    topicId,
    goalContext: formatGoalContextForTools(userGoals)
  })

  return {
    caseRecord,
    clientMessage: buildConnectedClientMessage(provider)
  }
}

const notifyFirmIntakeIssue = async (userGoals, text) => {
  for (const adminId of ADMIN_TELEGRAM_IDS) {
    try {
      await telegram.sendMessage(Number(adminId), text)
    } catch (error) {
      console.error("notifyFirmIntakeIssue error", adminId, error.message)
    }
  }
}

const dismissOtherOfferMessages = async (batchId, winningProviderId) => {
  const { data: messages, error } = await supabase
    .from("provider_case_offer_messages")
    .select(offerMessageSelect)
    .eq("batch_id", batchId)
    .neq("provider_id", winningProviderId)
    .eq("status", "pending")

  if (error) throw error

  for (const row of messages ?? []) {
    await dismissOfferMessage(row.chat_id, row.message_id)
    await supabase
      .from("provider_case_offer_messages")
      .update({ status: "dismissed" })
      .eq("id", row.id)
  }
}

const dismissOfferMessage = async (chatId, messageId) => {
  try {
    await telegram.deleteMessage(chatId, messageId)
  } catch (error) {
    console.error("dismissOfferMessage error", error.message)
  }
}

const buildConnectedClientMessage = (provider) =>
  renderTemplate("client/connected", { providerName: provider.name })

const buildProviderOfferText = (userGoals) =>
  renderTemplate("provider/offer", { intakeSummary: buildIntakeSummary(userGoals) })

const buildCaseTopicName = (caseId, closed = false) => {
  const prefix = closed ? "Closed — " : ""
  return `${prefix}Case #${caseId}`
}

const mapCaseRow = (row) => ({
  id: row.id,
  clientTelegramId: row.client_telegram_id,
  clientChatId: row.client_chat_id,
  providerId: row.provider_id,
  groupChatId: row.group_chat_id,
  topicId: row.topic_id,
  status: row.status,
  intakeSummary: row.intake_summary
})

const mapBatchRow = (row) => ({
  id: row.id,
  clientTelegramId: row.client_telegram_id,
  clientChatId: row.client_chat_id,
  status: row.status,
  acceptedProviderId: row.accepted_provider_id
})
