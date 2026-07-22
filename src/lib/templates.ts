import { existsSync, readFileSync } from "fs"
import path from "path"
import { PromptTemplate } from "@langchain/core/prompts"


const templatesRoot = path.join(process.cwd(), "templates")
const templateFolder = process.env.TEMPLATE_FOLDER || "base"
const cache = new Map()

const resolveTemplatePath = (name) => {
  const key = name.replace(/\.txt$/, "")
  const relativePath = `${key}.txt`

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
