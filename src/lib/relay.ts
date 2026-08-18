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

export const relayClientFile = async (caseRecord, fromChatId, messageId, label, withAnalyze) => {
  const caption = `[Client]: ${label}`
  const extra = {
    caption,
    message_thread_id: caseRecord.topicId
  }
  if (withAnalyze) {
    extra.reply_markup = {
      inline_keyboard: [[{ text: "Analyze", callback_data: `analyze:${caseRecord.id}` }]]
    }
  }

  await telegram.copyMessage(caseRecord.groupChatId, fromChatId, messageId, extra)
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "user", caption)
}

export const relayProviderFile = async (caseRecord, fromChatId, messageId, label) => {
  const roleLabel = loadTemplate("llm/assigned-role-label").trim()
  const caption = `[${roleLabel}]: ${label}`

  await telegram.copyMessage(caseRecord.clientChatId, fromChatId, messageId, { caption })
  await rag.saveConversationTurn(caseRecord.clientTelegramId, "provider", caption)
}

export const isRelayableFileMessage = (message) => {
  const { document, photo, video, audio, voice, animation } = message || {}
  return Boolean(document || photo || video || audio || voice || animation)
}

export const getFileRelayLabel = (message) => {
  const { document, photo, video, audio, voice, animation, caption } = message || {}
  if (caption) return caption
  if (document) {
    const name = document.file_name ? `: ${document.file_name}` : ""
    return `sent a file${name}`
  }
  if (photo) return "sent a photo"
  if (video) return "sent a video"
  if (audio) return "sent an audio file"
  if (voice) return "sent a voice message"
  if (animation) return "sent a GIF"
  return "sent a file"
}
