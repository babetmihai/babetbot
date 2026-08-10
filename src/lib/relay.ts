import rag from "./rag.ts"
import { sendToTopic, telegram } from "./telegram.ts"


export const relayClientMessage = async (caseRecord, message) => {
  const text = `[Client]: ${message.trim()}`

  await sendToTopic(caseRecord.groupChatId, caseRecord.topicId, text)
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "user", message)
}

export const relayProviderMessage = async (caseRecord, provider, message) => {
  const text = `${provider.name}:\n${message.trim()}`

  await telegram.sendMessage(caseRecord.clientChatId, text)
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "assistant", text)
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
