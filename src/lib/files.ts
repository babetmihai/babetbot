import fs from "fs"
import path from "path"
import axios from "axios"
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf"
import { HumanMessage } from "@langchain/core/messages"
import { ChatOpenAI } from "@langchain/openai"
import { getLlmMessageText } from "./agent.ts"
import type { CaseRecord } from "./cases.ts"
import rag, { PROMPT_TYPES } from "./rag.ts"
import { loadTemplate, renderTemplate } from "./templates.ts"
import { telegram } from "./telegram.ts"


const {
  OPENAI_API_KEY,
  AGENT_MODEL
} = process.env

const llm = new ChatOpenAI({
  apiKey: OPENAI_API_KEY,
  model: AGENT_MODEL,
  temperature: 0.2
})

const MAX_TEXT_CHARS = 12000
const MAX_CONTEXT_CHARS = 4000

export const analyzeTelegramFileMessage = async (message, caseRecord: CaseRecord) => {
  const fileInfo = getFileInfo(message)
  if (!fileInfo) throw new Error("No file found in this message.")

  const caseContext = await buildCaseContext(caseRecord)
  const savePath = await downloadTelegramFile(fileInfo.fileId, fileInfo.fileName)
  try {
    const isImage = Boolean(message.photo) || fileInfo.mimeType.startsWith("image/")
    if (isImage) {
      const summary = await summarizeImage(
        savePath,
        fileInfo.mimeType || "image/jpeg",
        fileInfo.fileName,
        caseContext
      )
      return summary
    }

    if (fileInfo.mimeType === "application/pdf") {
      const summary = await summarizePdf(savePath, fileInfo.fileName, caseContext)
      return summary
    }

    throw new Error("Only PDF and image files can be analyzed.")
  } finally {
    fs.unlinkSync(savePath)
  }
}

const getFileInfo = (message) => {
  const { document, photo } = message || {}
  if (document) {
    return {
      fileId: document.file_id,
      mimeType: document.mime_type || "application/octet-stream",
      fileName: document.file_name || null
    }
  }

  if (photo?.length) {
    const largest = photo[photo.length - 1]
    return {
      fileId: largest.file_id,
      mimeType: "image/jpeg",
      fileName: null
    }
  }

  return null
}

export const downloadTelegramFile = async (fileId, fileName) => {
  const fileLink = await telegram.getFileLink(fileId)
  const safeName = fileName || `file_${Date.now()}_${fileId.slice(0, 8)}`
  const savePath = path.join(process.cwd(), "downloads", safeName)

  fs.mkdirSync(path.dirname(savePath), { recursive: true })
  const writer = fs.createWriteStream(savePath)
  const response = await axios.get(fileLink.href, { responseType: "stream" })
  response.data.pipe(writer)
  await new Promise((resolve, reject) => {
    writer.on("finish", resolve)
    writer.on("error", reject)
  })

  return savePath
}

const summarizePdf = async (filePath, fileName, caseContext) => {
  const loader = new PDFLoader(filePath, { splitPages: true })
  const docs = await loader.load()
  const text = docs.map((doc) => doc.pageContent).join("\n\n").trim()
  if (!text) throw new Error("Could not extract text from this PDF.")

  const excerpt = text.length > MAX_TEXT_CHARS ? `${text.slice(0, MAX_TEXT_CHARS)}\n\n[Truncated]` : text
  const label = fileName || path.basename(filePath)
  return summarizeText(excerpt, label, "PDF document", caseContext)
}

const summarizeImage = async (filePath, mimeType, fileName, caseContext) => {
  const buffer = fs.readFileSync(filePath)
  const base64 = buffer.toString("base64")
  const dataUrl = `data:${mimeType};base64,${base64}`
  const label = fileName || path.basename(filePath)

  const response = await llm.invoke([
    new HumanMessage({
      content: [
        { type: "text", text: buildSummaryPrompt(label, "image", caseContext) },
        { type: "image_url", image_url: { url: dataUrl } }
      ]
    })
  ])

  const text = getLlmMessageText(response)
  if (!text) throw new Error("Could not summarize this file.")
  return text
}

const summarizeText = async (text, fileName, fileType, caseContext) => {
  const response = await llm.invoke([
    new HumanMessage(buildSummaryPrompt(fileName, fileType, caseContext, text))
  ])

  const summary = getLlmMessageText(response)
  if (!summary) throw new Error("Could not summarize this file.")
  return summary
}

const buildSummaryPrompt = (fileName, fileType, caseContext, text = null) => {
  const fileContentSection = text ? `\n\nFile content:\n${text}` : ""
  return renderTemplate("llm/file-summary", {
    fileName,
    fileType,
    caseContext: caseContext || "No prior case context available.",
    fileContentSection
  })
}

const buildCaseContext = async (caseRecord) => {
  const parts = []

  if (caseRecord.intakeSummary) {
    parts.push(`Intake:\n${caseRecord.intakeSummary}`)
  }

  const assignedRoleLabel = loadTemplate("llm/assigned-role-label").trim()
  const turns = await rag.listRecent(caseRecord.clientTelegramId, 12, { type: PROMPT_TYPES.conversation })
  const lines = turns.reverse().map((row) => {
    const isClient = row.metadata.role === "user"
    const role = isClient ? "Client" : assignedRoleLabel
    return `${role}: ${row.pageContent}`
  })

  if (lines.length) {
    parts.push(`Recent conversation:\n${lines.join("\n")}`)
  }

  const context = parts.join("\n\n").trim()
  if (!context) return "No prior case context available."
  if (context.length <= MAX_CONTEXT_CHARS) return context
  return `${context.slice(0, MAX_CONTEXT_CHARS)}\n\n[Truncated]`
}

