import { createMiddleware, ToolMessage } from "langchain"

const handleToolErrors = createMiddleware({
  name: "HandleToolErrors",
  wrapToolCall: async (request, handler) => {
    try {
      const result = await handler(request)
      return result
    } catch (error) {
      return new ToolMessage({
        content: error.message,
        tool_call_id: request.toolCall.id!,
        name: request.toolCall.name
      })
    }
  }
})

export default handleToolErrors
