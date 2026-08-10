import db from "./firestore.js"
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
  id: string
  number: number
  clientTelegramId: string
  clientChatId: number
  providerId: string
  groupChatId: number
  topicId: number
  status: "active" | "closed"
  intakeSummary: string | null
}

const notifiedIntakeBlocks = new Set()


export const fetchActiveCase = async (clientTelegramId) => {
  const snapshot = await db.collection("cases")
    .where("clientTelegramId", "==", clientTelegramId)
    .where("status", "==", "active")
    .orderBy("createdAt", "desc")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const fetchActiveCaseInTopic = async (groupChatId, topicId) => {
  const snapshot = await db.collection("cases")
    .where("groupChatId", "==", groupChatId)
    .where("topicId", "==", topicId)
    .where("status", "==", "active")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const fetchClosedCaseInTopic = async (groupChatId, topicId) => {
  const snapshot = await db.collection("cases")
    .where("groupChatId", "==", groupChatId)
    .where("topicId", "==", topicId)
    .where("status", "==", "closed")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapCaseDoc(snapshot.docs[0])
}

export const fetchPendingOfferBatch = async (clientTelegramId) => {
  const snapshot = await db.collection("provider_case_offer_batches")
    .where("clientTelegramId", "==", clientTelegramId)
    .where("status", "==", "pending")
    .limit(1)
    .get()

  if (snapshot.empty) return null
  return mapBatchDoc(snapshot.docs[0])
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
  const ref = db.collection("cases").doc(caseId)
  const closedAt = new Date().toISOString()
  await ref.update({ status: "closed", closedAt })

  const doc = await ref.get()
  if (!doc.exists) return null

  const caseRecord = mapCaseDoc(doc)

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
  await editForumTopic(caseRecord.groupChatId, caseRecord.topicId, buildCaseTopicName(caseRecord.number, true))

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
  const batchRef = db.collection("provider_case_offer_batches").doc()

  const created = await db.runTransaction(async (tx) => {
    const pending = await tx.get(
      db.collection("provider_case_offer_batches")
        .where("clientTelegramId", "==", clientTelegramId)
        .where("status", "==", "pending")
        .limit(1)
    )
    if (!pending.empty) return null

    tx.set(batchRef, {
      clientTelegramId,
      clientChatId,
      status: "pending",
      acceptedProviderId: null,
      createdAt: new Date().toISOString(),
      acceptedAt: null
    })
    return true
  })

  if (!created) {
    return renderTemplate("client/waiting-for-provider")
  }

  const batch = {
    id: batchRef.id,
    clientTelegramId,
    clientChatId,
    status: "pending",
    acceptedProviderId: null
  }
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

    await batchRef.collection("messages").doc(provider.id).set({
      batchId: batch.id,
      providerId: provider.id,
      chatId,
      messageId: sent.message_id,
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

  const offerRef = db.collection("provider_case_offer_batches").doc(batchId)
    .collection("messages").doc(provider.id)
  const offerDoc = await offerRef.get()
  if (!offerDoc.exists) {
    return { toast: "This offer is not for you." }
  }

  const offerMessage = mapOfferDoc(offerDoc)
  const batchRef = db.collection("provider_case_offer_batches").doc(batchId)

  const claimed = await db.runTransaction(async (tx) => {
    const batchDoc = await tx.get(batchRef)
    if (!batchDoc.exists) return null
    if (batchDoc.data().status !== "pending") return null

    tx.update(batchRef, {
      status: "accepted",
      acceptedProviderId: provider.id,
      acceptedAt: new Date().toISOString()
    })

    return mapBatchDoc(batchDoc)
  })

  if (!claimed) {
    await dismissOfferMessage(offerMessage.chatId, offerMessage.messageId)
    return { toast: "This case was already taken." }
  }

  const batch = {
    ...claimed,
    status: "accepted",
    acceptedProviderId: provider.id
  }
  const userGoals = await mergeUserGoals(batch.clientTelegramId)
  const { clientMessage } = await finalizeAcceptedCase(
    batch.clientTelegramId,
    batch.clientChatId,
    userGoals,
    provider
  )

  await offerRef.update({ status: "accepted" })
  await dismissOtherOfferMessages(batchId, provider.id)
  await dismissOfferMessage(offerMessage.chatId, offerMessage.messageId)

  await telegram.sendMessage(batch.clientChatId, clientMessage)

  return { toast: "Case accepted." }
}

const declineProviderOffer = async (batchId, providerTelegramUserId) => {
  const provider = await fetchProviderByTelegramUserId(providerTelegramUserId)
  if (!provider) {
    return { toast: renderTemplate("bot/not-registered") }
  }

  const batchRef = db.collection("provider_case_offer_batches").doc(batchId)
  const batchDoc = await batchRef.get()
  if (!batchDoc.exists || batchDoc.data().status !== "pending") {
    return { toast: "This offer is no longer available." }
  }

  const batch = mapBatchDoc(batchDoc)
  const offerRef = batchRef.collection("messages").doc(provider.id)
  const offerDoc = await offerRef.get()
  if (!offerDoc.exists || offerDoc.data().status !== "pending") {
    return { toast: "This offer is not for you." }
  }

  const offerMessage = mapOfferDoc(offerDoc)
  await offerRef.update({ status: "declined" })
  await dismissOfferMessage(offerMessage.chatId, offerMessage.messageId)

  const remaining = await batchRef.collection("messages")
    .where("status", "==", "pending")
    .limit(1)
    .get()

  if (remaining.empty) {
    await db.runTransaction(async (tx) => {
      const current = await tx.get(batchRef)
      if (!current.exists) return
      if (current.data().status !== "pending") return
      tx.update(batchRef, { status: "exhausted" })
    })

    const userGoals = await mergeUserGoals(batch.clientTelegramId)
    await notifyFirmIntakeIssue(userGoals, renderTemplate("admin/all-declined", {
      intakeSummary: buildIntakeSummary(userGoals)
    }))

    await telegram.sendMessage(
      batch.clientChatId,
      renderTemplate("client/all-declined")
    )
  }

  return { toast: "Case declined." }
}

const finalizeAcceptedCase = async (clientTelegramId, clientChatId, userGoals, provider) => {
  const providerChatId = Number(provider.telegramUserId)
  const topicId = await createForumTopic(providerChatId, "New case")
  const intakeSummary = buildIntakeSummary(userGoals)
  const caseRef = db.collection("cases").doc()

  const result = await db.runTransaction(async (tx) => {
    const active = await tx.get(
      db.collection("cases")
        .where("clientTelegramId", "==", clientTelegramId)
        .where("status", "==", "active")
        .limit(1)
    )
    if (!active.empty) {
      return { raced: true, caseRecord: mapCaseDoc(active.docs[0]) }
    }

    const counterRef = db.collection("counters").doc("cases")
    const counterDoc = await tx.get(counterRef)
    const nextNumber = counterDoc.exists ? counterDoc.data().next : 1

    tx.set(counterRef, { next: nextNumber + 1 })
    tx.set(caseRef, {
      number: nextNumber,
      clientTelegramId,
      clientChatId,
      providerId: provider.id,
      groupChatId: providerChatId,
      topicId,
      status: "active",
      intakeSummary,
      createdAt: new Date().toISOString(),
      closedAt: null
    })
    return { raced: false, number: nextNumber }
  })

  if (result.raced) {
    const { linkIntakePaymentToCase } = await import("./payments.js")
    await linkIntakePaymentToCase(clientTelegramId, result.caseRecord.id)
    return {
      caseRecord: result.caseRecord,
      clientMessage: buildConnectedClientMessage(provider)
    }
  }

  const caseRecord = {
    id: caseRef.id,
    number: result.number,
    clientTelegramId,
    clientChatId,
    providerId: provider.id,
    groupChatId: providerChatId,
    topicId,
    status: "active",
    intakeSummary
  }

  await editForumTopic(providerChatId, topicId, buildCaseTopicName(caseRecord.number))
  await sendToTopic(providerChatId, topicId, intakeSummary)
  await sendToTopic(providerChatId, topicId, renderTemplate("provider/topic-opening"))

  const { linkIntakePaymentToCase, notifyPaidIntakeFeeInTopic } = await import("./payments.js")
  await notifyPaidIntakeFeeInTopic(caseRecord)
  await linkIntakePaymentToCase(clientTelegramId, caseRecord.id)

  console.log("[cases] accepted", {
    caseId: caseRecord.id,
    caseNumber: caseRecord.number,
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
  const snapshot = await db.collection("provider_case_offer_batches").doc(batchId)
    .collection("messages")
    .where("status", "==", "pending")
    .get()

  for (const doc of snapshot.docs) {
    if (doc.id === winningProviderId) continue
    const offer = mapOfferDoc(doc)
    await dismissOfferMessage(offer.chatId, offer.messageId)
    await doc.ref.update({ status: "dismissed" })
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

const buildCaseTopicName = (caseNumber, closed = false) => {
  const prefix = closed ? "Closed — " : ""
  return `${prefix}Case #${caseNumber}`
}

const mapCaseDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    number: data.number,
    clientTelegramId: data.clientTelegramId,
    clientChatId: data.clientChatId,
    providerId: data.providerId,
    groupChatId: data.groupChatId,
    topicId: data.topicId,
    status: data.status,
    intakeSummary: data.intakeSummary ?? null
  }
}

const mapBatchDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    clientTelegramId: data.clientTelegramId,
    clientChatId: data.clientChatId,
    status: data.status,
    acceptedProviderId: data.acceptedProviderId ?? null
  }
}

const mapOfferDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    batchId: data.batchId,
    providerId: data.providerId,
    chatId: data.chatId,
    messageId: data.messageId,
    status: data.status
  }
}
