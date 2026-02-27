import type { AnthropicRequestBody } from '../types'

const CHARS_PER_TOKEN = 3.5
const DEFAULT_TOKEN_LIMIT = 195_000
const MIN_MESSAGES_TO_KEEP = 4
const TOKENS_PER_IMAGE = 1600
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

function stripBase64FromMessages(messages: any[]): { messages: any[]; imageCount: number } {
  let imageCount = 0

  const cleaned = messages.map((msg: any) => {
    if (!Array.isArray(msg.content)) return msg

    const hasImage = msg.content.some(
      (part: any) =>
        part.type === 'image' ||
        part.type === 'image_url' ||
        part.source?.type === 'base64',
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
 * Get tool_use IDs from a single message's content blocks.
 */
function getToolUseIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) {
        ids.add(block.id)
      }
    }
  }
  return ids
}

/**
 * Get tool_result IDs from a single message's content blocks.
 */
function getToolResultIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        ids.add(block.tool_use_id)
      }
    }
  }
  return ids
}

/**
 * Clean up orphaned tool_use/tool_result pairs enforcing Anthropic's strict:
 * each tool_result must reference a tool_use in the IMMEDIATELY PRECEDING assistant message,
 * and each tool_use must have a matching tool_result in the IMMEDIATELY FOLLOWING user message.
 * Runs multiple passes until the message array is stable.
 */
function cleanupOrphanedToolMessages(messages: any[]): void {
  let changed = true
  let passes = 0

  while (changed && passes < 10) {
    changed = false
    passes++

    // Pass 1: For each user message containing tool_result blocks, verify that each
    // tool_use_id exists in the immediately preceding assistant message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'user' || !Array.isArray(msg.content)) continue
      if (!msg.content.some((b: any) => b.type === 'tool_result')) continue

      const prevToolUseIds = i > 0 ? getToolUseIds(messages[i - 1]) : new Set<string>()

      const before = msg.content.length
      msg.content = msg.content.filter((block: any) => {
        if (block.type === 'tool_result' && block.tool_use_id) {
          return prevToolUseIds.has(block.tool_use_id)
        }
        return true
      })

      if (msg.content.length < before) {
        console.log(`[TRUNCATE] Removed ${before - msg.content.length} orphaned tool_result(s) from msg ${i} (missing tool_use in prev assistant)`)
        changed = true
      }

      if (msg.content.length === 0) {
        messages.splice(i, 1)
        console.log(`[TRUNCATE] Removed empty user message at idx ${i}`)
        changed = true
      }
    }

    // Pass 2: For each assistant message containing tool_use blocks, verify that each
    // tool_use id a matching tool_result in the immediately following user message.
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue
      if (!msg.content.some((b: any) => b.type === 'tool_use')) continue

      const nextToolResultIds = i + 1 < messages.length ? getToolResultIds(messages[i + 1]) : new Set<string>()

      const before = msg.content.length
      msg.content = msg.content.filter((block: any) => {
        if (block.type === 'tool_use' && block.id) {
          return nextToolResultIds.has(block.id)
        }
        return true
      })

      if (msg.content.length < before) {
        console.log(`[TRUNCATE] Removed ${before - msg.content.length} orphaned tool_use(s) from msg ${i} (missing tool_result in next user)`)
        changed = true
      }

      if (msg.content.length === 0) {
        messages.splice(i, 1)
        console.log(`[TRUNCATE] Removed empty assistant message at idx ${i}`)
        changed = true
      }
    }

    // Pass 3: Fix role alternation — remove consecutive same-role messages
    for (let i = messages.length - 1; i > 0; i--) {
      if (messages[i].role === messages[i - 1].role) {
        console.log(`[TRUNCATE] Removed consecutive duplicate ${messages[i].role} at idx ${i}`)
        messages.splice(i, 1)
        changed = true
      }
    }

    // Ensure first message is from user
    while (messages.length > 0 && messages[0].role !== 'user') {
      console.log(`[TRUNCATE] Removed leading ${messages[0].role} message`)
      messages.splice(0, 1)
      changed = true
    }
  }

  if (passes > 1) {
    console.log(`[TRUNCATE] Cleanup stabilized after ${passes} passes`)
  }
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

    cleanupOrphanedToolMessages(messages)

    const newEstimate = estimateTokens(body)
    console.log(`[TRUNCATE] After cleanup: ~${newEstimate} estimated tokens, ${messages.length} messages`)

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
