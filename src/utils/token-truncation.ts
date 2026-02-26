import type { AnthropicRequestBody } from '../types'

const CHARS_PER_TOKEN = 3.5
const DEFAULT_TOKEN_LIMIT = 195_000 // Conservative buffer below 200K
const MIN_MESSAGES_TO_KEEP = 4 // Always keep at least the messages

export function estimateTokens(obj: unknown): number {
  const json = JSON.stringify(obj)
  return Math.ceil(json.length / CHARS_PER_TOKEN)
}

/**
 * Truncates older messages to fit within the token limit.
 * Preserves: system prompt, tools, and the most recent messages.
 * Removes messages from the beginning of the conversation.
 */
export function truncateIfNeeded(
  body: AnthropicRequestBody,
  tokenLimit: number = DEFAULT_TOKEN_LIMIT,
): boolean {
  const totalEstimate = estimateTokens(body)
  if (totalEstimate <= tokenLimit) {
    return false
  }

  const messages = body.messages
  if (!messages || messages.length <= MIN_MESSAGES_TO_KEEP) {
    return false
  }

  const overageTokens = totalEstimate - tokenLimit
  const overageChars = overageTokens * CHARS_PER_TOKEN

  let removedChars = 0
  let removeCount = 0

  for (let i = 0; i < messages.length - MIN_MESSAGES_TO_KEEP; i++) {
    removedChars += JSON.stringify(messages[i]).length
    removeCount++
    if (removedChars >= overageChars) break
  }

  if (removeCount > 0) {
    const removed = messages.splice(0, removeCount)
    console.log(
      `[TRUNCATE] Removed ${removed.length} oldest messages (~${Math.ceil(removedChars / CHARS_PER_TOKEN)} tokens) to fit within ${tokenLimit} token limit`,
    )

    // Ensure conversation starts with a user message (Anthropic requirement)
    if (messages.length > 0 && messages[0].role === 'assistant') {
      messages.splice(0, 1)
      console.log('[TRUNCATE] Removed leading assistant message to maintain alternation')
    }
    // Also handle tool_result messages that reference removed tool_use blocks
    while (
      messages.length > 0 &&
      messages[0].role === 'user' &&
      Array.isArray(messages[0].content) &&
      messages[0].content.every((c: any) => c.type === 'tool_result')
    ) {
      messages.splice(0, 1)
      console.log('[TRUNCATE] Removed orphaned tool_result message')
    }

    return true
  }

  return false
}

/**
 * Parses the token count from an Anthropic "prompt is too long" error.
 * Returns { actualTokens, maxTokens } or null if not a token limit error.
 */
export function parseTokenLimitError(
  errorText: string,
): { actualTokens: number; maxTokens: number } | null {
  const match = errorText.match(
    /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
  )
  if (!match) return null
  return {
    actualTokens: parseInt(match[1], 10),
    maxTokens: parseInt(match[2], 10),
  }
}
