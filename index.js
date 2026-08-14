import { readFile, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

export const name = 'dsh-image-bridge'
export const inject = ['tools']

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
})

export function apply(ctx, config) {
  const preset = PRESETS[config.preset]
  const baseURL = (config.baseURL ?? preset.baseURL ?? '').replace(/\/+$/, '')
  const model = config.model ?? preset.model
  const apiKeyEnv = config.apiKeyEnv ?? preset.apiKeyEnv ?? 'VISION_API_KEY'

  if (!baseURL || !model) {
    throw new Error('[dsh-image-bridge] preset "custom" requires both baseURL and model in the plugin config')
  }

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

      const apiKey = process.env[apiKeyEnv]
      if (!apiKey) {
        throw new Error(`Vision API key not found. Set the ${apiKeyEnv} environment variable (free key: https://open.bigmodel.cn/), or point apiKeyEnv elsewhere in the plugin config.`)
      }

      const info = await stat(filePath).catch(() => {
        throw new Error(`Image not found: ${filePath}`)
      })
      const limit = config.maxImageMB * 1024 * 1024
      if (info.size > limit) {
        throw new Error(`Image too large: ${(info.size / 1048576).toFixed(1)}MB exceeds the ${config.maxImageMB}MB limit`)
      }

      const imageBase64 = await readFile(filePath, 'base64')
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])

      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        signal,
        body: JSON.stringify({
          model,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: args.question },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${imageBase64}`, detail: config.detail } },
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

      return { answer, model }
    },
  }))
}
