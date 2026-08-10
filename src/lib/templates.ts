import { existsSync, readFileSync } from "fs"
import path from "path"
import { PromptTemplate } from "@langchain/core/prompts"


const templatesRoot = path.join(process.cwd(), "templates")
const templateFolder = process.env.TEMPLATE_FOLDER || "base"
const cache = new Map()

const resolveTemplatePath = (name, ext = "txt") => {
  const key = name.replace(new RegExp(`\\.${ext}$`), "")
  const relativePath = `${key}.${ext}`

  if (templateFolder && templateFolder !== "base") {
    const overridePath = path.join(templatesRoot, templateFolder, relativePath)
    if (existsSync(overridePath)) return overridePath
  }

  return path.join(templatesRoot, "base", relativePath)
}

export const loadTemplate = (name) => {
  const key = name.replace(/\.txt$/, "")
  if (!cache.has(key)) {
    cache.set(key, readFileSync(resolveTemplatePath(name), "utf8"))
  }
  return cache.get(key)
}

export const loadJsonTemplate = (name) => {
  const key = `json:${name.replace(/\.json$/, "")}`
  if (!cache.has(key)) {
    cache.set(key, JSON.parse(readFileSync(resolveTemplatePath(name, "json"), "utf8")))
  }
  return cache.get(key)
}

export const renderTemplate = (name, vars = {}) => {
  let text = loadTemplate(name)
  for (const [key, value] of Object.entries(vars)) {
    text = text.replaceAll(`{${key}}`, String(value))
  }
  return text.trim()
}

export const formatPromptTemplate = async (name, vars = {}) => {
  const template = PromptTemplate.fromTemplate(loadTemplate(name))
  return template.format(vars)
}
