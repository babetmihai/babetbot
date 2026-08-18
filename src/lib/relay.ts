import rag from "./rag.ts"
import { loadTemplate } from "./templates.ts"
import { sendToTopic, telegram } from "./telegram.ts"


const formatRelayLine = (role, message) => `[${role}]: ${message.trim()}`

export const relayClientMessage = async (caseRecord, message) => {
  const text = formatRelayLine("Client", message)

  await sendToTopic(caseRecord.groupChatId, caseRecord.topicId, text)
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "user", message)
}

export const relayProviderMessage = async (caseRecord, message) => {
  const text = message.trim()
  const roleLabel = loadTemplate("llm/assigned-role-label").trim()

  await telegram.sendMessage(caseRecord.clientChatId, formatRelayLine(roleLabel, text))
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "provider", text)
}

export const relayClientFile = async (caseRecord, fileId, fileType, label) => {
  const caption = `[Client]: ${label}`
  const replyMarkup = {
    inline_keyboard: [[{ text: "Analyze", callback_data: `analyze:${caseRecord.id}` }]]
  }
  const extra = {
    caption,
    message_thread_id: caseRecord.topicId,
    reply_markup: replyMarkup
  }

  if (fileType === "photo") {
    await telegram.sendPhoto(caseRecord.groupChatId, fileId, extra)
  } else {
    await telegram.sendDocument(caseRecord.groupChatId, fileId, extra)
  }

  await rag.saveConversationTurn(caseRecord.clientTelegramId, "user", caption)
}
