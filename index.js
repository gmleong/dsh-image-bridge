import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-img'
// llm/attachments power the chat bridge (declaring image input + reading
// attachment bytes); both ship with dsh-base, so every real profile has them.
export const inject = ['tools', 'llm', 'attachments']

/**
 * Vision backend presets. zhipu and qwen both offer free-tier vision models,
 * so a fresh install works with zero spend; `custom` covers any
 * OpenAI-compatible vision endpoint (gateways, self-hosted vLLM, ...).
 */
const PRESETS = {
  zhipu: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4v-flash',
    apiKeyEnv: 'ZHIPU_API_KEY',
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-vl-plus',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  custom: {},
}

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

const DEFAULT_BRIDGE_PROMPT = [
  '请详细描述这张图片的全部内容，让另一个看不到图的 AI 助手读完你的描述后能准确理解这张图：',
  '① 图中所有可见文字（逐字转录）② 界面/页面布局与关键元素 ③ 图表、数据、代码等细节。',
  '用简洁的中文分点回答。',
].join('')

export const Config = Schema.object({
  preset: Schema.union(['zhipu', 'qwen', 'custom']).default('zhipu')
    .description('Vision backend preset: zhipu = GLM-4V-Flash (free), qwen = Qwen-VL (free quota), custom = your own OpenAI-compatible endpoint.'),
  baseURL: Schema.string()
    .description('OpenAI-compatible base URL. Required when preset is custom; overrides the preset otherwise.'),
  model: Schema.string()
    .description('Vision model id. Overrides the preset default.'),
  apiKeyEnv: Schema.string()
    .description('Name of the environment variable holding the API key. Defaults to the preset’s variable.'),
  timeoutMs: Schema.number().default(60000)
    .description('Per-request timeout in milliseconds.'),
  maxImageMB: Schema.number().default(10)
    .description('Refuse images larger than this many megabytes.'),
  detail: Schema.union(['auto', 'low', 'high']).default('auto')
    .description('Image detail hint passed to the endpoint (OpenAI-compatible semantics).'),
  chatBridge: Schema.boolean().default(true)
    .description('Let the chat box accept image attachments for text-only models: declare image input and transcribe attached images to text via the vision backend before each request.'),
  bridgePrompt: Schema.string().default(DEFAULT_BRIDGE_PROMPT)
    .description('The question sent to the vision backend when transcribing chat attachments.'),
})

/** Shared vision call: base64 image + question → textual answer. */
async function callVision(cfg, image, question, signal) {
  const res = await fetch(`${cfg.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${image.apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: cfg.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}`, detail: cfg.detail } },
        ],
      }],
    }),
  })

  if (!res.ok) {
    const body = (await res.text()).slice(0, 500)
    throw new Error(`Vision API HTTP ${res.status}: ${body}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  const answer = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => part?.text ?? '').join('')
      : ''
  if (!answer) throw new Error('Vision API returned an empty answer')
  return answer
}

/** Walk content blocks, including nested tool-result content. */
function hasImageBlock(content) {
  return Array.isArray(content) && content.some(block =>
    block?.type === 'image' || (block?.type === 'tool-result' && hasImageBlock(block.content)))
}

export function apply(ctx, config) {
  const preset = PRESETS[config.preset]
  const cfg = {
    baseURL: (config.baseURL ?? preset.baseURL ?? '').replace(/\/+$/, ''),
    model: config.model ?? preset.model,
    apiKeyEnv: config.apiKeyEnv ?? preset.apiKeyEnv ?? 'VISION_API_KEY',
    detail: config.detail,
    timeoutMs: config.timeoutMs,
  }

  if (!cfg.baseURL || !cfg.model) {
    throw new Error('[dsh-img] preset "custom" requires both baseURL and model in the plugin config')
  }

  const requireApiKey = () => {
    const apiKey = process.env[cfg.apiKeyEnv]
    if (!apiKey) {
      throw new Error(`Vision API key not found. Set the ${cfg.apiKeyEnv} environment variable (free key: https://open.bigmodel.cn/), or point apiKeyEnv elsewhere in the plugin config.`)
    }
    return apiKey
  }

  // ── analyze_image tool ────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'analyze_image',
    description: [
      'Analyze an image file with a vision model and return a textual answer.',
      'Use it for OCR, layout/UI understanding, chart reading, or any question about an image.',
      'The conversation model may be text-only — this tool is its eyes.',
    ].join(' '),
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the image, or a path relative to the workspace root.',
      },
      question: {
        type: 'string',
        required: true,
        description: 'What to extract or answer, e.g. "Transcribe all visible text" or "Describe the page layout".',
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          model: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.answer }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)

      const mime = MIME[extname(filePath).toLowerCase()]
      if (!mime) {
        throw new Error(`Unsupported image type "${extname(filePath) || '(none)'}". Supported: ${Object.keys(MIME).join(' ')}`)
      }

      const apiKey = requireApiKey()

      const info = await stat(filePath).catch(() => {
        throw new Error(`Image not found: ${filePath}`)
      })
      const limit = config.maxImageMB * 1024 * 1024
      if (info.size > limit) {
        throw new Error(`Image too large: ${(info.size / 1048576).toFixed(1)}MB exceeds the ${config.maxImageMB}MB limit`)
      }

      const base64 = await readFile(filePath, 'base64')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      const answer = await callVision(cfg, { base64, mediaType: mime, apiKey }, args.question, signal)
      return { answer, model: cfg.model }
    },
  }))

  // ── chat bridge: attach images straight into a text-only chat ─────────
  if (!config.chatBridge) return

  const llm = ctx.get('llm', false)
  const attachments = ctx.get('attachments', false)
  if (!llm || !attachments) {
    console.warn('[dsh-img] chat bridge disabled: llm/attachments service not available in this profile (analyze_image still works)')
    return
  }

  // 1. Admit images: the web UI asks resolveModelInfo() before accepting an
  //    attachment and rejects with MODEL_DOES_NOT_SUPPORT_IMAGES when the
  //    declared modalities lack "image". The DeepSeek adapter hardcodes
  //    ["text"], so widen the declaration — the transcoder below makes it true.
  try {
    const original = llm.resolveModelInfo.bind(llm)
    llm.resolveModelInfo = async (provider, model, signal) => {
      const info = await original(provider, model, signal)
      if (info?.inputModalities && !info.inputModalities.includes('image')) {
        return { ...info, inputModalities: [...info.inputModalities, 'image'] }
      }
      return info
    }
  } catch (error) {
    console.warn('[dsh-img] could not widen model input modalities; chat attachments may stay blocked:', error?.message ?? error)
  }

  // 2. Transcode: the cordis waterfall re-invokes listeners with the original
  //    args (next(modified) would be ignored), so instead of calling next with
  //    rewritten messages we re-enter llm.stream with a transcoded copy; the
  //    second pass finds no image blocks and falls through to the adapter.
  //    Transcriptions are cached per content-addressed attachment, because the
  //    session log keeps the image block and every later step re-sends it.
  const cache = new Map()
  const cacheKey = ref => ref.id ?? ref.digest ?? JSON.stringify(ref)

  const transcribe = async (ref, signal) => {
    const key = cacheKey(ref)
    if (cache.has(key)) return cache.get(key)

    let text
    try {
      const stored = await attachments.readImage(ref, signal)
      const mediaType = stored.mediaType ?? ref.mediaType ?? 'image/png'
      const base64 = Buffer.from(stored.data).toString('base64')
      const answer = await callVision(
        cfg,
        { base64, mediaType, apiKey: requireApiKey() },
        config.bridgePrompt,
        AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      )
      text = `[图片转述 · ${cfg.model}]\n${answer}`
    } catch (error) {
      text = `[图片转述失败：${error?.message ?? error}。请检查 ${cfg.apiKeyEnv} 环境变量或 dsh-img 配置。]`
    }

    if (cache.size >= 200) cache.delete(cache.keys().next().value)
    cache.set(key, text)
    return text
  }

  const transcodeContent = async (content, signal) => {
    const out = []
    for (const block of content) {
      if (block?.type === 'image' && block.attachment) {
        out.push({ type: 'text', text: await transcribe(block.attachment, signal) })
      } else if (block?.type === 'tool-result' && hasImageBlock(block.content)) {
        out.push({ ...block, content: await transcodeContent(block.content, signal) })
      } else {
        out.push(block)
      }
    }
    return out
  }

  // The llm/stream result must be an async iterable of chunks, so this
  // listener stays synchronous: the image path returns an async generator
  // that transcribes first, then delegates into a re-entered llm.stream.
  ctx.on('llm/stream', (options, next) => {
    const messages = options?.messages
    if (!Array.isArray(messages) || !messages.some(m => hasImageBlock(m?.content))) return next()

    return (async function* () {
      const signal = options.signal ?? new AbortController().signal
      const transcoded = []
      for (const message of messages) {
        transcoded.push(hasImageBlock(message?.content)
          ? { ...message, content: await transcodeContent(message.content, signal) }
          : message)
      }
      yield* llm.stream({ ...options, messages: transcoded })
    })()
  })
}
