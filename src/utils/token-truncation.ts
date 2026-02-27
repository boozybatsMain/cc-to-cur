import type { AnthropicRequestBody } from '../types'

const CHARS_PER_TOKEN = 3.5
const DEFAULT_TOKEN_LIMIT = 195_000
const MIN_MESSAGES_TO_KEEP = 4
const TOKENS_PER_IMAGE = 1600 // Anthropic charges ~1600 tokens per image regardless of base64 size
const BASE64_PATTERN = /^data:image\/[^;]+;base64,/

/**
 * Estimate tokens for an object, correctly handling base64 images.
 * Images are counted as a fixed ~1600 tokens instead of by character length.
 */
export function estimateTokens(obj: unknown): number {
  if (obj === null || obj === undefined) return 0

  let imageTokens = 0
  let jsonWithoutImages: string

  if (Array.isArray(obj)) {
    const cleaned = stripBase64FromMessages(obj)
    imageTokens = cleaned.imageCount * TOKENS_PER_IMAGE
    jsonWithoutImages = JSON.stringify(cleaned.messages)
  } else if (typeof obj === 'object') {
    const body = obj as any
    if (body.messages) {
      const cleaned = stripBase64FromMessages(body.messages)
      imageTokens = cleaned.imageCount * TOKENS_PER_IMAGE
      const bodyCopy = { ...body, messages: cleaned.messages }
      jsonWithoutImages = JSON.stringify(bodyCopy)
    } else {
      jsonWithoutImages = JSON.stringify(obj)
    }
  } else {
    jsonWithoutImages = JSON.stringify(obj)
  }

  const textTokens = Math.ceil(jsonWithoutImages.length / CHARS_PER_TOKEN)
  return textTokens + imageTokens
}

/**
 * Strip base64 data from messages for accurate token counting.
 * Returns cleaned messages (shallow copy) and the count of images found.
 */
function stripBase64FromMessages(messages: any[]): { messages: any[]; imageCount: number } {
  let imageCount = 0

  const cleaned = messages.map((msg: any) => {
    if (!Array.isArray(msg.content)) return msg

    const hasImage = msg.content.some(
      (part: any) =>
        part.type === 'image' ||
        (part.type === 'image_url') ||
        (part.source?.type === 'base64'),
    )
    if (!hasImage) return msg

    const newContent = msg.content.map((part: any) => {
      if (part.source?.type === 'base64') {
        imageCount++
        return { ...part, source: { ...part.source, data: '[IMAGE]' } }
      }
      if (part.type === 'image_url' && part.image_url?.url?.match(BASE64_PATTERN)) {
        imageCount++
        return { ...part, image_url: { ...part.image_url, url: '[IMAGE]' } }
      }
      if (part.type === 'image') {
        imageCount++
        return { type: 'image', source: { type: 'placeholder' } }
      }
      return part
    })

    return { ...msg, content: newContent }
  })

  return { messages: cleaned, imageCount }
}

/**
 * Estimate tokens for a single message, handling images correctly.
 */
function estimateMessageTokens(msg: any): number {
  if (!Array.isArray(msg.content)) {
    return Math.ceil(JSON.stringify(msg).length / CHARS_PER_TOKEN)
  }

  let imageCount = 0
  const cleanedContent = msg.content.map((part: any) => {
    if (part.source?.type === 'base64') {
      imageCount++
      return { ...part, source: { ...part.source, data: '[IMAGE]' } }
    }
    if (part.type === 'image_url' && part.image_url?.url?.match(BASE64_PATTERN)) {
      imageCount++
      return { ...part, image_url: { ...part.image_url, url: '[IMAGE]' } }
    }
    if (part.type === 'image') {
      imageCount++
      return { type: 'image', source: { type: 'placeholder' } }
    }
    return part
  })

  const textTokens = Math.ceil(JSON.stringify({ ...msg, content: cleanedContent }).length / CHARS_PER_TOKEN)
  return textTokens + imageCount * TOKENS_PER_IMAGE
}

/**
 * Truncates messages from the MIDDLE of the conversation to fit within token limit.
 * Preserves: system prompt, tools, first user message (original question), and recent messages.
 */
export function truncateIfNeeded(
  body: AnthropicRequestBody,
  tokenLimit: number = DEFAULT_TOKEN_LIMIT,
): boolean {
  const systemEstimate = estimateTokens(body.system)
  const toolsEstimate = estimateTokens((body as any).tools)
  const messagesEstimate = estimateTokens(body.messages)
  const totalEstimate = estimateTokens(body)

  console.log(`[TRUNCATE-CHECK] estimated: total=${totalEstimate} system=${systemEstimate} tools=${toolsEstimate} messages=${messagesEstimate} limit=${tokenLimit} msgCount=${body.messages?.length ?? 0}`)

  if (totalEstimate <= tokenLimit) {
    return false
  }

  const messages = body.messages
  if (!messages || messages.length <= MIN_MESSAGES_TO_KEEP) {
    console.log(`[TRUNCATE] ⚠️ Over limit by ~${totalEstimate - tokenLimit} tokens but only ${messages?.length ?? 0} messages — cannot truncate further`)
    return false
  }

  const overageTokens = totalEstimate - tokenLimit
  const overageChars = overageTokens * CHARS_PER_TOKEN

  console.log(`[TRUNCATE] 🔪 Need to remove ~${overageTokens} tokens (~${Math.ceil(overageChars)} chars). Messages: ${messages.length}`)

  // Strategy: preserve first 2 messages (original user question + first assistant reply)
  // and the last MIN_MESSAGES_TO_KEEP messages. Remove from the middle.
  const preserveStart = 2
  const preserveEnd = MIN_MESSAGES_TO_KEEP
  const removableStart = preserveStart
  const removableEnd = messages.length - preserveEnd

  if (removableStart >= removableEnd) {
    console.log(`[TRUNCATE] ⚠️ Not enough messages in the middle to remove (preserveStart=${preserveStart}, preserveEnd=${preserveEnd}, total=${messages.length})`)
    return false
  }

  let removedTokens = 0
  let removeFromIdx = removableStart
  let removeToIdx = removableStart
  const removedRoles: string[] = []

  for (let i = removableStart; i < removableEnd; i++) {
    const msgTokens = estimateMessageTokens(messages[i])
    removedTokens += msgTokens
    removedRoles.push(`${messages[i].role}(${msgTokens}t)`)
    removeToIdx = i + 1
    if (removedTokens >= overageTokens) break
  }

  const removeCount = removeToIdx - removeFromIdx
  if (removeCount > 0) {
    const removed = messages.splice(removeFromIdx, removeCount)
    console.log(
      `[TRUNCATE] ✅ Removed ${removed.length} MIDDLE messages (idx ${removeFromIdx}..${removeToIdx - 1}, ~${removedTokens} tokens). Remaining: ${messages.length} messages`,
    )
    console.log(`[TRUNCATE] Removed breakdown: ${removedRoles.join(', ')}`)

    // Fix alternation: if removal created two consecutive same-role messages
    for (let i = removeFromIdx; i < messages.length - 1; i++) {
      if (messages[i].role === messages[i - 1]?.role && messages[i].role === 'assistant') {
        messages.splice(i, 1)
        console.log(`[TRUNCATE] Removed duplicate assistant at idx ${i}`)
        i--
      }
    }
    // Remove orphaned tool_result messages at the splice point
    while (
      removeFromIdx < messages.length &&
      messages[removeFromIdx].role === 'user' &&
      Array.isArray(messages[removeFromIdx].content) &&
      messages[removeFromIdx].content.every((c: any) => c.type === 'tool_result')
    ) {
      messages.splice(removeFromIdx, 1)
      console.log('[TRUNCATE] Removed orphaned tool_result message at splice point')
    }

    // Ensure no two consecutive same-role messages at splice boundary
    if (
      removeFromIdx > 0 &&
      removeFromIdx < messages.length &&
      messages[removeFromIdx - 1].role === messages[removeFromIdx].role
    ) {
      if (messages[removeFromIdx].role === 'assistant') {
        messages.splice(removeFromIdx, 1)
        console.log('[TRUNCATE] Removed duplicate role at boundary')
      }
    }

    const newEstimate = estimateTokens(body)
    console.log(`[TRUNCATE] After truncation: ~${newEstimate} estimated tokens, ${messages.length} messages`)

    return true
  }

  return false
}

/**
 * Parses the token count from an Anthropic "prompt is too long" error.
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
