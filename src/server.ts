import { Hono, Context } from 'hono'
import { stream } from 'hono/streaming'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAccessToken } from './auth/oauth-manager'
import {
  login as oauthLogin,
  logout as oauthLogout,
  generateAuthSession,
  handleOAuthCallback,
} from './auth/oauth-flow'
import {
  createConverterState,
  processChunk,
  convertNonStreamingResponse,
} from './utils/anthropic-to-openai-converter'
import { corsPreflightHandler, corsMiddleware } from './utils/cors-bypass'
import {
  isCursorKeyCheck,
  createCursorBypassResponse,
} from './utils/cursor-byok-bypass'
import type {
  AnthropicRequestBody,
  AnthropicResponse,
  ErrorResponse,
  SuccessResponse,
  ModelsListResponse,
  ModelInfo,
} from './types'

// Static files are served by Vercel, not needed here

const app = new Hono()

// Handle CORS preflight requests for all routes
app.options('*', corsPreflightHandler)

// Also add CORS headers to all responses
app.use('*', corsMiddleware)

const indexHtmlPath = join(process.cwd(), 'public', 'index.html')
let cachedIndexHtml: string | null = null

const getIndexHtml = async () => {
  if (!cachedIndexHtml) {
    cachedIndexHtml = await readFile(indexHtmlPath, 'utf-8')
  }
  return cachedIndexHtml
}

// Root route is handled by serving public/index.html directly
app.get('/', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

app.get('/index.html', async (c) => {
  const html = await getIndexHtml()
  return c.html(html)
})

// New OAuth start endpoint for UI
app.post('/auth/oauth/start', async (c: Context) => {
  try {
    const { authUrl, sessionId } = await generateAuthSession()

    return c.json({
      success: true,
      authUrl,
      sessionId,
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'Failed to start OAuth flow',
        message: (error as Error).message,
      },
      500,
    )
  }
})

// New OAuth callback endpoint for UI
app.post('/auth/oauth/callback', async (c: Context) => {
  try {
    const body = await c.req.json()
    const { code } = body

    if (!code) {
      return c.json<ErrorResponse>(
        {
          error: 'Missing OAuth code',
          message: 'OAuth code is required',
        },
        400,
      )
    }

    // Extract verifier from code if it contains #
    const splits = code.split('#')
    const verifier = splits[1] || ''

    await handleOAuthCallback(code, verifier)

    return c.json<SuccessResponse>({
      success: true,
      message: 'OAuth authentication successful',
    })
  } catch (error) {
    return c.json<ErrorResponse>(
      {
        error: 'OAuth callback failed',
        message: (error as Error).message,
      },
      500,
    )
  }
})

app.post('/auth/login/start', async (c: Context) => {
  try {
    console.log('\n Starting OAuth authentication flow...')
    const result = await oauthLogin()
    if (result) {
      return c.json<SuccessResponse>({
        success: true,
        message: 'OAuth authentication successful',
      })
    } else {
      return c.json<SuccessResponse>(
        { success: false, message: 'OAuth authentication failed' },
        401,
      )
    }
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/logout', async (c: Context) => {
  try {
    await oauthLogout()
    return c.json<SuccessResponse>({
      success: true,
      message: 'Logged out successfully',
    })
  } catch (error) {
    return c.json<SuccessResponse>(
      { success: false, message: (error as Error).message },
      500,
    )
  }
})

app.get('/auth/status', async (c: Context) => {
  try {
    const token = await getAccessToken()
    return c.json({ authenticated: !!token })
  } catch (error) {
    return c.json({ authenticated: false })
  }
})

app.get('/v1/models', async (c: Context) => {
  try {
    // Fetch models from models.dev
    const response = await fetch('https://models.dev/api.json', {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      },
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    const modelsData = (await response.json()) as any

    // Extract Anthropic models and format them like OpenAI's API would
    const anthropicProvider = modelsData.anthropic
    if (!anthropicProvider || !anthropicProvider.models) {
      return c.json<ModelsListResponse>({
        object: 'list',
        data: [],
      })
    }

    // Convert models to OpenAI's format
    const models: ModelInfo[] = Object.entries(anthropicProvider.models).map(
      ([modelId, modelData]: [string, any]) => {
        // Convert release date to Unix timestamp
        const releaseDate = modelData.release_date || '1970-01-01'
        const created = Math.floor(new Date(releaseDate).getTime() / 1000)

        return {
          id: modelId,
          object: 'model' as const,
          created: created,
          owned_by: 'anthropic',
        }
      },
    )

    // Sort models by created timestamp (newest first)
    models.sort((a, b) => b.created - a.created)

    // Add alias models that map to real Anthropic models
    for (const [alias] of Object.entries(MODEL_ALIASES)) {
      models.unshift({
        id: alias,
        object: 'model' as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: 'deepseek',
      })
    }

    const response_data: ModelsListResponse = {
      object: 'list',
      data: models,
    }

    return c.json(response_data)
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
})

// Map of alias model names to actual Anthropic model IDs
const MODEL_ALIASES: Record<string, string> = {
  'deepseek-coder': 'claude-opus-4-6',
}

// Normalize model names from various formats to valid Anthropic model IDs
function normalizeModelName(model: string): string {
  const originalModel = model

  // Check alias map first
  const lowerModel = model.toLowerCase()
  if (MODEL_ALIASES[lowerModel]) {
    model = MODEL_ALIASES[lowerModel]
    console.log(`Normalized model name: ${originalModel} -> ${model}`)
    return model
  }
  
  // Handle Cursor's format like "claude-4.6-opus-high" -> "claude-opus-4-6"
  // Pattern: claude-{version}-{family}-{variant}
  const cursorPattern = /^claude-(\d+(?:\.\d+)?)-(\w+)(?:-\w+)?$/i
  const match = model.match(cursorPattern)
  if (match) {
    const version = match[1].replace('.', '-') // "4.6" -> "4-6"
    const family = match[2].toLowerCase() // "opus", "sonnet", "haiku"
    model = `claude-${family}-${version}`
  }
  
  // Also handle dots in version: "claude-opus-4.6" -> "claude-opus-4-6"
  model = model.replace(/claude-(\w+)-(\d+)\.(\d+)/i, 'claude-$1-$2-$3')
  
  if (model !== originalModel) {
    console.log(`Normalized model name: ${originalModel} -> ${model}`)
  }
  
  return model
}

const messagesFn = async (c: Context) => {
  try {
  let headers: Record<string, string> = c.req.header() as Record<string, string>
  headers.host = 'api.anthropic.com'
  const body: AnthropicRequestBody = await c.req.json()
  const isStreaming = body.stream === true
  
  console.log(`[REQ] model=${body.model} stream=${isStreaming} messages=${body.messages?.length ?? 0} tools=${(body as any).tools?.length ?? 0}`)

  // Normalize model name to valid Anthropic format
  body.model = normalizeModelName(body.model)

  // Only check API key if API_KEY env var is set and not empty/placeholder
  const envApiKey = process.env.API_KEY
  if (envApiKey && envApiKey !== '' && envApiKey !== '-' && envApiKey !== '_') {
    const apiKey = c.req.header('authorization')?.split(' ')?.[1]
    if (apiKey !== envApiKey) {
      return c.json(
        {
          error: 'Authentication required',
          message: 'API key does not match. Check your Vercel API_KEY environment variable.',
        },
        401,
      )
    }
  }

  // Bypass cursor enable openai key check
  if (isCursorKeyCheck(body)) {
    return c.json(createCursorBypassResponse())
  }

  // Remove OpenAI-specific parameters that Claude doesn't accept
  delete (body as any).stream_options
  delete (body as any).frequency_penalty
  delete (body as any).presence_penalty
  delete (body as any).logit_bias
  delete (body as any).logprobs
  delete (body as any).top_logprobs
  delete (body as any).n
  delete (body as any).user
  delete (body as any).response_format

  // Convert OpenAI tool_choice format to Anthropic format
  if ((body as any).tool_choice !== undefined) {
    const tc = (body as any).tool_choice
    if (tc === 'auto') {
      (body as any).tool_choice = { type: 'auto' }
    } else if (tc === 'none') {
      delete (body as any).tool_choice
    } else if (tc === 'required') {
      (body as any).tool_choice = { type: 'any' }
    } else if (tc?.type === 'function' && tc?.function?.name) {
      (body as any).tool_choice = { type: 'tool', name: tc.function.name }
    }
  }

  // Convert OpenAI-format tools to Anthropic format
  if ((body as any).tools) {
    (body as any).tools = (body as any).tools
      .map((tool: any) => {
        if (tool.type === 'function' && tool.function) {
          return {
            name: tool.function.name,
            description: tool.function.description || '',
            input_schema: tool.function.parameters || { type: 'object', properties: {} },
          }
        }
        return tool
      })
  }

  // Convert OpenAI-format messages to Anthropic format
  if (body.messages) {
    const convertedMessages: any[] = []
    for (const msg of body.messages) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        const content: any[] = []
        if (msg.content) {
          content.push({ type: 'text', text: String(msg.content) })
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name || '',
            input: typeof tc.function?.arguments === 'string'
              ? JSON.parse(tc.function.arguments || '{}')
              : (tc.function?.arguments || {}),
          })
        }
        convertedMessages.push({ role: 'assistant', content })
      } else if (msg.role === 'tool') {
        convertedMessages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: String(msg.content ?? ''),
          }],
        })
      } else {
        const converted = { ...msg }
        // Normalize content: ensure text fields are valid strings
        if (converted.content === null || converted.content === undefined) {
          converted.content = ''
        } else if (Array.isArray(converted.content)) {
          converted.content = converted.content.map((part: any) => {
            if (part.type === 'text') {
              return { ...part, text: String(part.text ?? '') }
            }
            return part
          })
        } else if (typeof converted.content !== 'string') {
          converted.content = String(converted.content)
        }
        convertedMessages.push(converted)
      }
    }
    body.messages = convertedMessages
  }

  try {
    let transformToOpenAIFormat = false

    if (
      !body.system?.[0]?.text?.includes(
        "You are Claude Code, Anthropic's official CLI for Claude.",
      ) && body.messages
    ) {
      const systemMessages = body.messages.filter((msg: any) => msg.role === 'system')
      body.messages = body.messages?.filter((msg: any) => msg.role !== 'system')
      transformToOpenAIFormat = true // not claude-code, need to transform to openai format
      if (!body.system) {
        body.system = []
      }
      body.system.unshift({
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      })

      for (const sysMsg of systemMessages) {
        const sysText = typeof sysMsg.content === 'string'
          ? sysMsg.content
          : Array.isArray(sysMsg.content)
            ? sysMsg.content.map((p: any) => p.text ?? '').join('\n')
            : String(sysMsg.content ?? '')
        body.system.push({
          type: 'text',
          text: sysText,
        })
      }

      if (body.model.includes('opus')) {
        body.max_tokens = 128_000
      }
      if (body.model.includes('sonnet')) {
        body.max_tokens = 64_000
      }

      // Enable extended thinking
      // Opus 4.6+ requires adaptive thinking (budget_tokens is deprecated)
      if (body.model.includes('opus-4-6')) {
        body.thinking = {
          type: 'adaptive',
        }
      } else {
        // Older models use budget_tokens
        const maxTokens = (body.max_tokens as number) || 32000
        body.thinking = {
          type: 'enabled',
          budget_tokens: maxTokens > 16000 ? 16000 : maxTokens - 1000,
        }
      }
    }

    const oauthToken = await getAccessToken()

    if (!oauthToken) {
      return c.json<ErrorResponse>(
        {
          error: 'Authentication required',
          message:
            'Please authenticate using OAuth first. Visit /auth/login for instructions.',
        },
        401,
      )
    }

    // When thinking is enabled, remove temperature (not supported with thinking)
    if (body.thinking) {
      delete (body as any).temperature
      delete (body as any).top_p
      delete (body as any).top_k
    }

    headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${oauthToken}`,
      'anthropic-beta':
        'oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14,interleaved-thinking-2025-05-14',
      'anthropic-version': '2023-06-01',
      'user-agent': '@anthropic-ai/sdk 1.2.12 node/22.13.1',
      accept: isStreaming ? 'text/event-stream' : 'application/json',
      'accept-encoding': 'gzip, deflate',
    }

    if (transformToOpenAIFormat) {
      if (!body.metadata) {
        body.metadata = {}
      }

      if (!body.system) {
        body.system = []
      }
    }

    console.log(`[FWD] model=${body.model} transform=${transformToOpenAIFormat} thinking=${JSON.stringify(body.thinking)} max_tokens=${body.max_tokens} msgs=${body.messages?.length} tools=${(body as any).tools?.length ?? 0}`)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: c.req.raw.signal,
    })

    if (!response.ok) {
      const error = await response.text()
      console.error('API Error:', error)

      if (response.status === 401) {
        return c.json<ErrorResponse>(
          {
            error: 'Authentication failed',
            message:
              'OAuth token may be expired. Please re-authenticate using /auth/login/start',
            details: error,
          },
          401,
        )
      }
      return new Response(error, {
        status: response.status,
        headers: { 'Content-Type': 'text/plain' },
      })
    }

    if (isStreaming) {
      response.headers.forEach((value, key) => {
        if (
          key.toLowerCase() !== 'content-encoding' &&
          key.toLowerCase() !== 'content-length' &&
          key.toLowerCase() !== 'transfer-encoding'
        ) {
          c.header(key, value)
        }
      })

      const reader = response.body!.getReader()
      const decoder = new TextDecoder()

      return stream(c, async (stream) => {
        const converterState = createConverterState()
        const enableLogging = false

        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break

            const chunk = decoder.decode(value, { stream: true })

            if (transformToOpenAIFormat) {
              if (enableLogging) {
                console.log('🔄 [TRANSFORM MODE] Converting to OpenAI format')
              }

              const results = processChunk(converterState, chunk, enableLogging)

              for (const result of results) {
                if (result.type === 'ping') {
                  // Forward as SSE comment to keep connection alive during long thinking
                  await stream.write(': ping\n\n')
                } else if (result.type === 'chunk') {
                  const dataToSend = `data: ${JSON.stringify(result.data)}\n\n`
                  if (enableLogging) {
                    console.log('✅ [SENDING] OpenAI Chunk:', dataToSend)
                  }
                  await stream.write(dataToSend)
                } else if (result.type === 'done') {
                  await stream.write('data: [DONE]\n\n')
                }
              }
            } else {
              await stream.write(chunk)
            }
          }
        } catch (error) {
          console.error('Stream error:', error)
        } finally {
          reader.releaseLock()
        }
      })
    } else {
      const responseData = (await response.json()) as AnthropicResponse

      if (transformToOpenAIFormat) {
        const openAIResponse = convertNonStreamingResponse(responseData)

        response.headers.forEach((value, key) => {
          if (key.toLowerCase() !== 'content-encoding') {
            c.header(key, value)
          }
        })

        return c.json(openAIResponse)
      }

      response.headers.forEach((value, key) => {
        if (key.toLowerCase() !== 'content-encoding') {
          c.header(key, value)
        }
      })

      return c.json(responseData)
    }
  } catch (error) {
    console.error('Proxy error:', error)
    return c.json<ErrorResponse>(
      { error: 'Proxy error', details: (error as Error).message },
      500,
    )
  }
  } catch (outerError) {
    console.error('[FATAL] Unhandled error in messagesFn:', outerError)
    return c.json<ErrorResponse>(
      { error: 'Internal error', details: (outerError as Error).message },
      500,
    )
  }
}

app.post('/v1/chat/completions', messagesFn)
app.post('/v1/messages', messagesFn)

const port = process.env.PORT || 9095

// Export app for Vercel
export default app

// Start server for local development with extended timeouts for long thinking
if (process.env.NODE_ENV !== 'production') {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { serve } = require('@hono/node-server') as { serve: Function }
  const server = serve({
    fetch: app.fetch,
    port: Number(port),
  })

  const httpServer = server as import('node:http').Server
  httpServer.requestTimeout = 0
  httpServer.headersTimeout = 0
  httpServer.timeout = 0

  console.log(`🚀 Server running on http://localhost:${port}`)
}
