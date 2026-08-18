import db, { firestore } from "./firestore.ts"
import checkpointer from "./checkpointer.ts"
import {
  buildIntakeSummary,
  formatGoalContextForTools,
  mergeUserGoals,
  resetClientIntake
} from "./goals.ts"
import { renderTemplate } from "./templates.ts"
import {
  adminTelegramId,
  closeForumTopic,
  createForumTopic,
  editForumTopic,
  fetchAdmin,
  isAdmin,
  notifyAdmin,
  sendToTopic,
  telegram
} from "./telegram.ts"


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
    await checkpointer.deleteThread(caseRecord.clientTelegramId)
  } catch (error) {
    console.error("deleteThread error", caseRecord.clientTelegramId, error.message)
  }

  await editForumTopic(caseRecord.groupChatId, caseRecord.topicId, buildCaseTopicName(caseRecord.number, true))

  const isSupergroupForum = caseRecord.groupChatId < 0
  if (isSupergroupForum) {
    await closeForumTopic(caseRecord.groupChatId, caseRecord.topicId)
  }

  return caseRecord
}

export const escalateToProvider = async (clientTelegramId, clientChatId, userGoals) => {
  const existing = await fetchActiveCase(clientTelegramId)
  if (existing) {
    const admin = await fetchAdmin()
    return renderTemplate("client/already-connected", { providerName: admin.name })
  }

  const pendingOffer = await fetchPendingOffer(clientTelegramId)
  if (pendingOffer) {
    return renderTemplate("client/waiting-for-provider")
  }

  return startCaseOffer(clientTelegramId, clientChatId, userGoals)
}

export const acceptCaseOffer = async (offerId, actorTelegramUserId) => {
  if (!isAdmin(actorTelegramUserId)) {
    return { toast: "Not allowed." }
  }

  const offerRef = db.collection("case_offers").doc(offerId)
  const claimed = await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(offerRef)
    if (!doc.exists) return null
    if (doc.data().status !== "pending") return null
    tx.update(offerRef, {
      status: "accepted",
      acceptedAt: new Date().toISOString()
    })
    return mapOfferDoc(doc)
  })

  if (!claimed) {
    return { toast: "This offer is no longer available." }
  }

  try {
    const admin = await fetchAdmin()
    const userGoals = await mergeUserGoals(claimed.clientTelegramId)
    const { clientMessage } = await finalizeAcceptedCase(
      claimed.clientTelegramId,
      claimed.clientChatId,
      userGoals,
      admin
    )
    await telegram.sendMessage(claimed.clientChatId, clientMessage)
    return { toast: "Case accepted." }
  } catch (error) {
    console.error("acceptCaseOffer error", error.message)
    await offerRef.update({ status: "pending", acceptedAt: null })
    throw error
  }
}

export const declineCaseOffer = async (offerId, actorTelegramUserId) => {
  if (!isAdmin(actorTelegramUserId)) {
    return { toast: "Not allowed." }
  }

  const offerRef = db.collection("case_offers").doc(offerId)
  const declined = await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(offerRef)
    if (!doc.exists) return null
    if (doc.data().status !== "pending") return null
    tx.update(offerRef, { status: "declined" })
    return mapOfferDoc(doc)
  })

  if (!declined) {
    return { toast: "This offer is no longer available." }
  }

  await telegram.sendMessage(
    declined.clientChatId,
    renderTemplate("client/declined")
  )
  return { toast: "Case declined." }
}

const fetchPendingOffer = async (clientTelegramId) => {
  const doc = await db.collection("case_offers").doc(clientTelegramId).get()
  if (!doc.exists) return null
  const offer = mapOfferDoc(doc)
  if (offer.status !== "pending") return null
  return offer
}

const startCaseOffer = async (clientTelegramId, clientChatId, userGoals) => {
  const offerRef = db.collection("case_offers").doc(clientTelegramId)
  const adminChatId = Number(adminTelegramId)

  const created = await firestore.runTransaction(async (tx) => {
    const current = await tx.get(offerRef)
    const alreadyPending = current.exists && current.data().status === "pending"
    if (alreadyPending) return false
    tx.set(offerRef, {
      clientTelegramId,
      clientChatId,
      status: "pending",
      createdAt: new Date().toISOString(),
      acceptedAt: null
    })
    return true
  })

  if (!created) {
    return renderTemplate("client/waiting-for-provider")
  }

  const offerText = renderTemplate("provider/offer", { intakeSummary: buildIntakeSummary(userGoals) })
  try {
    await telegram.sendMessage(adminChatId, offerText, {
      reply_markup: {
        inline_keyboard: [[
          { text: "Accept client", callback_data: `offer:${clientTelegramId}:accept` },
          { text: "Decline", callback_data: `offer:${clientTelegramId}:decline` }
        ]]
      }
    })
    console.log("[cases] offer sent", { clientTelegramId, adminChatId })
  } catch (error) {
    console.error("startCaseOffer send error", error.message)
    await offerRef.delete()
    await notifyIntakeBlocked(clientTelegramId, userGoals)
    return renderTemplate("client/intake-blocked")
  }

  return renderTemplate("client/waiting-for-provider")
}

const notifyIntakeBlocked = async (clientTelegramId, userGoals) => {
  const ref = db.collection("intake_block_notifications").doc(`${clientTelegramId}_no_provider`)
  const claimed = await firestore.runTransaction(async (tx) => {
    const doc = await tx.get(ref)
    if (doc.exists) return false
    tx.set(ref, {
      clientTelegramId,
      reason: "no_provider",
      createdAt: new Date().toISOString()
    })
    return true
  })
  if (!claimed) return

  await notifyAdmin(renderTemplate("admin/intake-no-provider", {
    intakeSummary: buildIntakeSummary(userGoals)
  }))
}

const finalizeAcceptedCase = async (clientTelegramId, clientChatId, userGoals, admin) => {
  const adminChatId = Number(admin.telegramUserId)
  const intakeSummary = buildIntakeSummary(userGoals)
  const caseRef = db.collection("cases").doc()
  const connectedMessage = renderTemplate("client/connected", { providerName: admin.name })

  const result = await firestore.runTransaction(async (tx) => {
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
      providerId: admin.telegramUserId,
      groupChatId: adminChatId,
      topicId: null,
      status: "active",
      intakeSummary,
      createdAt: new Date().toISOString(),
      closedAt: null
    })
    return { raced: false, number: nextNumber }
  })

  if (result.raced) {
    return {
      caseRecord: result.caseRecord,
      clientMessage: connectedMessage
    }
  }

  let topicId
  try {
    topicId = await createForumTopic(adminChatId, buildCaseTopicName(result.number))
    await caseRef.update({ topicId })
  } catch (error) {
    await caseRef.delete()
    throw error
  }

  const caseRecord = {
    id: caseRef.id,
    number: result.number,
    clientTelegramId,
    clientChatId,
    providerId: admin.telegramUserId,
    groupChatId: adminChatId,
    topicId,
    status: "active",
    intakeSummary
  }

  await sendToTopic(
    adminChatId,
    topicId,
    `${intakeSummary}\n\n${renderTemplate("provider/topic-opening")}`
  )

  console.log("[cases] accepted", {
    caseId: caseRecord.id,
    caseNumber: caseRecord.number,
    clientTelegramId,
    provider: admin.name,
    topicId,
    goalContext: formatGoalContextForTools(userGoals)
  })

  return {
    caseRecord,
    clientMessage: connectedMessage
  }
}

const buildCaseTopicName = (caseNumber, closed = false) => {
  const prefix = closed ? "Closed — " : ""
  return `${prefix}Case #${caseNumber}`
}

const mapOfferDoc = (doc) => {
  const data = doc.data()
  return {
    id: doc.id,
    clientTelegramId: data.clientTelegramId,
    clientChatId: data.clientChatId,
    status: data.status
  }
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
