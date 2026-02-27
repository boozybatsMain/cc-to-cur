import type { AnthropicRequestBody } from '../types'

const CHARS_PER_TOKEN = 3.5
const DEFAULT_TOKEN_LIMIT = 195_000
const MIN_MESSAGES_TO_KEEP = 4
const TOKENS_PER_IMAGE = 1600
const BASE64_PATTERN = /^data:image\/[^;]+;base64,/

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

interface Round {
  startIdx: number
  endIdx: number // exclusive
  tokens: number
  msgCount: number
}

/**
 * Groups messages into complete conversation rounds. A round starts with a user
 * message (the human turn) and includes all subsequent assistant→user(tool_result)
 * exchanges until the next "real" user message (one that isn't just tool_results).
 *
 * Example conversation:
 *   [0] user "fix the bug"           ← Round 1 start
 *   [1] assistant (text + tool_use)
 *   [2] user (tool_result)
 *   [3] assistant (text + tool_use)
 *   [4] user (tool_result)
 *   [5] assistant "done!"
 *   [6] user "now add tests"         ← Round 2 start
 *   [7] assistant "ok, here..."
 *
 * Round 1 = messages 0..5 (indices 0-5), Round 2 = messages 6..7
 *
 * Removing a full round is always safe — no orphaned tool pairs.
 */
function groupIntoRounds(messages: any[]): Round[] {
  const rounds: Round[] = []
  let roundStart = 0

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]

    // A new round starts at a user message that is NOT a pure tool_result response
    if (msg.role === 'user') {
      const isPureToolResult = Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((b: any) => b.type === 'tool_result')

      if (!isPureToolResult) {
        // Close the previous round
        let tokens = 0
        for (let j = roundStart; j < i; j++) {
          tokens += estimateMessageTokens(messages[j])
        }
        rounds.push({ startIdx: roundStart, endIdx: i, tokens, msgCount: i - roundStart })
        roundStart = i
      }
    }
  }

  // Close the last round
  let tokens = 0
  for (let j = roundStart; j < messages.length; j++) {
    tokens += estimateMessageTokens(messages[j])
  }
  rounds.push({ startIdx: roundStart, endIdx: messages.length, tokens, msgCount: messages.length - roundStart })

  return rounds
}

/**
 * Truncates complete conversation rounds from the middle to fit within token limit.
 * Preserves the first round (original user question) and the last rounds (recent context).
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
  console.log(`[TRUNCATE] 🔪 Need to remove ~${overageTokens} tokens. Total messages: ${messages.length}`)

  const rounds = groupIntoRounds(messages)
  console.log(`[TRUNCATE] Found ${rounds.length} conversation rounds: ${rounds.map((r, i) => `R${i}[msgs ${r.startIdx}-${r.endIdx - 1}, ${r.tokens}t]`).join(', ')}`)

  if (rounds.length <= 2) {
    console.log(`[TRUNCATE] ⚠️ Only ${rounds.length} round(s) — cannot remove any`)
    return false
  }

  // Always preserve first round and last round; remove from the middle
  const removableRounds = rounds.slice(1, -1)
  let removedTokens = 0
  const roundsToRemove: number[] = []

  for (let r = 0; r < removableRounds.length; r++) {
    roundsToRemove.push(r + 1) // +1 because index 0 is preserved
    removedTokens += removableRounds[r].tokens
    if (removedTokens >= overageTokens) break
  }

  if (roundsToRemove.length === 0) return false

  // all message indices to remove
  const indicesToRemove: number[] = []
  for (const roundIdx of roundsToRemove) {
    const round = rounds[roundIdx]
    for (let idx = round.startIdx; idx < round.endIdx; idx++) {
      indicesToRemove.push(idx)
    }
  }

  console.log(`[TRUNCATE] Removing ${roundsToRemove.length} round(s) (${indicesToRemove.length} messages, ~${removedTokens} tokens)`)

  // Remove in reverse order
  indicesToRemove.sort((a, b) => b - a)
  for (const idx of indicesToRemove) {
    messages.splice(idx, 1)
  }

  console.log(`[TRUNCATE] ✅ After removal: ${messages.length} messages`)

  // Validate
  const issues = validateMessages(messages)
  if (issues.length > 0) {
    console.log(`[TRUNCATE] ⚠️ Validation issues: ${issues.join('; ')}`)
  }

  const newEstimate = estimateTokens(body)
  console.log(`[TRUNCATE] Final estimate: ~${newEstimate} tokens, ${messages.length} messages`)

  return true
}

function getToolUseIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_use' && block.id) ids.add(block.id)
    }
  }
  return ids
}

function getToolResultIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    for (const block of msg.content) {
      if (block.type === 'tool_result' && block.tool_use_id) ids.add(block.tool_use_id)
    }
  }
  return ids
}

function validateMessages(messages: any[]): string[] {
  const issues: string[] = []
  if (messages.length === 0) return ['No messages']
  if (messages[0].role !== 'user') {
    issues.push(`First message is ${messages[0].role}, expected user`)
  }
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      issues.push(`Consecutive ${messages[i].role} at idx ${i - 1},${i}`)
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          const prevUseIds = i > 0 ? getToolUseIds(messages[i - 1]) : new Set<string>()
          if (!prevUseIds.has(block.tool_use_id)) {
            issues.push(`Orphaned tool_result ${block.tool_use_id} at msg ${i}`)
          }
        }
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && block.id) {
          const nextResultIds = i + 1 < messages.length ? getToolResultIds(messages[i + 1]) : new Set<string>()
          if (!nextResultIds.has(block.id)) {
            issues.push(`Orphaned tool_use ${block.id} at msg ${i}`)
          }
        }
      }
    }
  }
  return issues
}

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
