import type { AnthropicRequestBody } from '../types'

const CHARS_PER_TOKEN = 3.5
const DEFAULT_TOKEN_LIMIT = 195_000
const MIN_MESSAGES_TO_KEEP = 4
const TOKENS_PER_IMAGE = 1600
const BASE64_PATTERN = /^data:image\/[^;]+;base64,/

// ── Token estimation ──────────────────────────────────────────────

export function estimateTokens(obj: unknown): number {
  if (obj === null || obj === undefined) return 0
  let imageTokens = 0
  let jsonWithoutImages: string
  if (Array.isArray(obj)) {
    const cleaned = stripBase64(obj)
    imageTokens = cleaned.imageCount * TOKENS_PER_IMAGE
    jsonWithoutImages = JSON.stringify(cleaned.messages)
  } else if (typeof obj === 'object') {
    const body = obj as any
    if (body.messages) {
      const cleaned = stripBase64(body.messages)
      imageTokens = cleaned.imageCount * TOKENS_PER_IMAGE
      jsonWithoutImages = JSON.stringify({ ...body, messages: cleaned.messages })
    } else {
      jsonWithoutImages = JSON.stringify(obj)
    }
  } else {
    jsonWithoutImages = JSON.stringify(obj)
  }
  return Math.ceil(jsonWithoutImages.length / CHARS_PER_TOKEN) + imageTokens
}

function estimateMessageTokens(msg: any): number {
  if (!Array.isArray(msg.content)) {
    return Math.ceil(JSON.stringify(msg).length / CHARS_PER_TOKEN)
  }
  let imageCount = 0
  const cleanedContent = msg.content.map((part: any) => {
    if (part.source?.type === 'base64') {
      imageCount++
      return { ...part, source: { ...part.source, data: '[IMG]' } }
    }
    if (part.type === 'image_url' && part.image_url?.url?.match(BASE64_PATTERN)) {
      imageCount++
      return { ...part, image_url: { ...part.image_url, url: '[IMG]' } }
    }
    if (part.type === 'image') {
      imageCount++
      return { type: 'image', source: { type: 'placeholder' } }
    }
    return part
  })
  return Math.ceil(JSON.stringify({ ...msg, content: cleanedContent }).length / CHARS_PER_TOKEN) + imageCount * TOKENS_PER_IMAGE
}

function stripBase64(messages: any[]): { messages: any[]; imageCount: number } {
  let imageCount = 0
  const cleaned = messages.map((msg: any) => {
    if (!Array.isArray(msg.content)) return msg
    if (!msg.content.some((p: any) => p.type === 'image' || p.type === 'image_url' || p.source?.type === 'base64')) return msg
    const newContent = msg.content.map((part: any) => {
      if (part.source?.type === 'base64') { imageCount++; return { ...part, source: { ...part.source, data: '[IMG]' } } }
      if (part.type === 'image_url' && part.image_url?.url?.match(BASE64_PATTERN)) { imageCount++; return { ...part, image_url: { ...part.image_url, url: '[IMG]' } } }
      if (part.type === 'image') { imageCount++; return { type: 'image', source: { type: 'placeholder' } } }
      return part
    })
    return { ...msg, content: newContent }
  })
  return { messages: cleaned, imageCount }
}

// ── Round grouping ────────────────────────────────────────────────

interface Round {
  startIdx: number
  endIdx: number
  tokens: number
}

/**
 * Groups messages into conversation rounds. A round starts at is NOT a pure tool_result, and includes everything until the next such
 * user message. Removing a full round never orphans tool pairs.
 */
function groupIntoRounds(messages: any[]): Round[] {
  const rounds: Round[] = []
  let roundStart = 0
  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user') {
      const isPureToolResult = Array.isArray(msg.content) &&
        msg.content.length > 0 &&
        msg.content.every((b: any) => b.type === 'tool_result')
      if (!isPureToolResult) {
        let tokens = 0
        for (let j = roundStart; j < i; j++) tokens += estimateMessageTokens(messages[j])
        rounds.push({ startIdx: roundStart, endIdx: i, tokens })
        roundStart = i
      }
    }
  }
  let tokens = 0
  for (let j = roundStart; j < messages.length; j++) tokens += estimateMessageTokens(messages[j])
  rounds.push({ startIdx: roundStart, endIdx: messages.length, tokens })
  return rounds
}

// ── Tool pair identification within a round ───────────────────────

interface ToolPair {
  assistantIdx: number
  userIdx: number
  tokens: number
}

/**
 * Finds removable tool call pairs within a message array.
 * A tool pair = assistant message with tool_use + following user message with tool_result.
 * We skip the very first exchange (user question + first assistant) and the last few
 * messages to preserve context at both ends.
 */
function findToolPairs(messages: any[]): ToolPair[] {
  const pairs: ToolPair[] = []
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i]
    const next = messages[i + 1]
    if (
      msg.role === 'assistant' && Array.isArray(msg.content) &&
      msg.content.some((b: any) => b.type === 'tool_use') &&
      next.role === 'user' && Array.isArray(next.content) &&
      next.content.some((b: any) => b.type === 'tool_result')
    ) {
      pairs.push({
        assistantIdx: i,
        userIdx: i + 1,
        tokens: estimateMessageTokens(msg) + estimateMessageTokens(next),
      })
    }
  }
  return pairs
}

/**
 * Removes tool pairs from the middle of the conversation to free up tokens.
 * Preserves the first 2 messages and last MIN_MESSAGES_TO_KEEP messages.
 * Returns true if any messages were removed.
 */
function trimToolPairs(messages: any[], overageTokens: number): boolean {
  const pairs = findToolPairs(messages)
  if (pairs.length === 0) return false

  // Only remove pairs that are in the "middle" — not at the very start or end
  const safeEnd = messages.length - MIN_MESSAGES_TO_KEEP
  const removablePairs = pairs.filter(p => p.assistantIdx >= 2 && p.userIdx < safeEnd)

  if (removablePairs.length === 0) return false

  let removedTokens = 0
  const indicesToRemove = new Set<number>()

  for (const pair of removablePairs) {
    indicesToRemove.add(pair.assistantIdx)
    indicesToRemove.add(pair.userIdx)
    removedTokens += pair.tokens
    if (removedTokens >= overageTokens) break
  }

  console.log(`[TRUNCATE] Removing ${indicesToRemove.size} messages from ${indicesToRemove.size / 2} tool pair(s) (~${removedTokens} tokens)`)

  const sorted = Array.from(indicesToRemove).sort((a, b) => b - a)
  for (const idx of sorted) {
    messages.splice(idx, 1)
  }

  return true
}

// ── Main truncation entry point ───────────────────────────────────

export function truncateIfNeeded(
  body: AnthropicRequestBody,
  tokenLimit: number = DEFAULT_TOKEN_LIMIT,
): boolean {
  const systemEstimate = estimateTokens(body.system)
  const toolsEstimate = estimateTokens((body as any).tools)
  const messagesEstimate = estimateTokens(body.messages)
  const totalEstimate = estimateTokens(body)

  console.log(`[TRUNCATE-CHECK] estimated: total=${totalEstimate} system=${systemEstimate} tools=${toolsEstimate} messages=${messagesEstimate} limit=${tokenLimit} msgCount=${body.messages?.length ?? 0}`)

  if (totalEstimate <= tokenLimit) return false

  const messages = body.messages
  if (!messages || messages.length <= MIN_MESSAGES_TO_KEEP) {
    console.log(`[TRUNCATE] ⚠️ Over limit by ~${totalEstimate - tokenLimit} tokens but only ${messages?.length ?? 0} messages — cannot truncate`)
    return false
  }

  const overageTokens = totalEstimate - tokenLimit
  console.log(`[TRUNCATE] 🔪 Need to remove ~${overageTokens} tokens. Total messages: ${messages.length}`)

  // Strategy A: remove complete middle rounds
  const rounds = groupIntoRounds(messages)
  console.log(`[TRUNCATE] Found ${rounds.length} rounds: ${rounds.map((r, i) => `R${i}[${r.startIdx}-${r.endIdx - 1}, ${r.tokens}t]`).join(', ')}`)

  if (rounds.length > 2) {
    const removableRounds = rounds.slice(1, -1)
    let removedTokens = 0
    const roundsToRemove: number[] = []

    for (let r = 0; r < removableRounds.length; r++) {
      roundsToRemove.push(r + 1)
      removedTokens += removableRounds[r].tokens
      if (removedTokens >= overageTokens) break
    }

    if (roundsToRemove.length > 0) {
      const indicesToRemove: number[] = []
      for (const ri of roundsToRemove) {
        for (let idx = rounds[ri].startIdx; idx < rounds[ri].endIdx; idx++) {
          indicesToRemove.push(idx)
        }
      }

      console.log(`[TRUNCATE] Strategy A: removing ${roundsToRemove.length} round(s) (${indicesToRemove.length} msgs, ~${removedTokens}t)`)
      indicesToRemove.sort((a, b) => b - a)
      for (const idx of indicesToRemove) messages.splice(idx, 1)

      logResult(body, messages)
      return true
    }
  }

  // Strategy B: remove tool call pairs from within large rounds
  console.log(`[TRUNCATE] Strategy B: trimming tool pairs from within rounds`)
  const trimmed = trimToolPairs(messages, overageTokens)
  if (trimmed) {
    logResult(body, messages)
    return true
  }

  console.log(`[TRUNCATE] ⚠️ No strategy could free enough tokens`)
  return false
}

function logResult(body: AnthropicRequestBody, messages: any[]): void {
  const issues = validateMessages(messages)
  if (issues.length > 0) {
    console.log(`[TRUNCATE] ⚠️ Validation: ${issues.join('; ')}`)
  }
  const est = estimateTokens(body)
  console.log(`[TRUNCATE] ✅ Result: ~${est} tokens, ${messages.length} messages`)
}

// ── Validation ────────────────────────────────────────────────────

function getToolUseIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'assistant' && Array.isArray(msg.content)) {
    for (const b of msg.content) if (b.type === 'tool_use' && b.id) ids.add(b.id)
  }
  return ids
}

function getToolResultIds(msg: any): Set<string> {
  const ids = new Set<string>()
  if (msg.role === 'user' && Array.isArray(msg.content)) {
    for (const b of msg.content) if (b.type === 'tool_result' && b.tool_use_id) ids.add(b.tool_use_id)
  }
  return ids
}

function validateMessages(messages: any[]): string[] {
  const issues: string[] = []
  if (messages.length === 0) return ['Empty']
  if (messages[0].role !== 'user') issues.push(`First msg is ${messages[0].role}`)
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      issues.push(`Consecutive ${messages[i].role} at ${i - 1},${i}`)
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_result' && b.tool_use_id) {
          const prev = i > 0 ? getToolUseIds(messages[i - 1]) : new Set<string>()
          if (!prev.has(b.tool_use_id)) issues.push(`Orphan tool_result ${b.tool_use_id} at ${i}`)
        }
      }
    }
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use' && b.id) {
          const next = i + 1 < messages.length ? getToolResultIds(messages[i + 1]) : new Set<string>()
          if (!next.has(b.id)) issues.push(`Orphan tool_use ${b.id} at ${i}`)
        }
      }
    }
  }
  return issues
}

// ── Error parsing ─────────────────────────────────────────────────

export function parseTokenLimitError(
  errorText: string,
): { actualTokens: number; maxTokens: number } | null {
  const match = errorText.match(/prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i)
  if (!match) return null
  return { actualTokens: parseInt(match[1], 10), maxTokens: parseInt(match[2], 10) }
}
