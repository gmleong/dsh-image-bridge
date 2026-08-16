import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import potrace from 'potrace'
import sharp from 'sharp'

const execFileAsync = promisify(execFile)
const trace = promisify(potrace.trace)

export const name = 'dsh-img'
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

// ── Config ──────────────────────────────────────────────────────────────
// `preset` is kept single-value for backwards compatibility but `backends`
// is the new first-class field: an ordered list of independently-configured
// vision backends that fail over left-to-right. When `backends` is omitted,
// the single `preset` is treated as a one-element chain.
const BackendSchema = Schema.object({
  preset: Schema.union(['zhipu', 'qwen', 'custom']).default('zhipu')
    .description('Backend preset: zhipu = GLM-4V-Flash (free), qwen = Qwen-VL (free quota), custom = your own OpenAI-compatible endpoint.'),
  baseURL: Schema.string()
    .description('OpenAI-compatible base URL. Required when preset is custom; overrides the preset otherwise.'),
  model: Schema.string()
    .description('Vision model id. Overrides the preset default.'),
  apiKeyEnv: Schema.string()
    .description('Name of the environment variable holding the API key. Defaults to the preset’s variable.'),
})

export const Config = Schema.object({
  preset: Schema.union(['zhipu', 'qwen', 'custom']).default('zhipu')
    .description('Legacy single-backend shortcut. Prefer `backends`.'),
  backends: Schema.array(BackendSchema)
    .description('Ordered vision backends; the first that answers wins, failures fall through to the next.'),
  baseURL: Schema.string().description('Deprecated: use a backend entry.'),
  model: Schema.string().description('Deprecated: use a backend entry.'),
  apiKeyEnv: Schema.string().description('Deprecated: use a backend entry.'),
  timeoutMs: Schema.number().default(60000)
    .description('Per-request timeout in milliseconds.'),
  maxImageMB: Schema.number().default(10)
    .description('Refuse images larger than this many megabytes.'),
  detail: Schema.union(['auto', 'low', 'high']).default('auto')
    .description('Image detail hint passed to the endpoint (OpenAI-compatible semantics).'),
  chatBridge: Schema.boolean().default(true)
    .description('Let the chat box accept image attachments for text-only models.'),
  bridgePrompt: Schema.string().default(DEFAULT_BRIDGE_PROMPT)
    .description('The question sent to the vision backend when transcribing chat attachments.'),
  cache: Schema.boolean().default(true)
    .description('Persist vision answers in a content-addressed disk cache (~/.dsh/dsh-img-cache).'),
  ocrLang: Schema.string().default('chi_sim+eng')
    .description('Tesseract language pack(s) for local OCR, e.g. "chi_sim+eng".'),
  pixelDiffSampleMax: Schema.number().default(1024)
    .description('Longest edge used when downsampling images for pixel-diff (bounds CPU cost).'),
  traceSteps: Schema.number().default(4)
    .description('Posterization color steps for vision_trace (potrace).'),
  foregroundTolerance: Schema.number().default(40)
    .description('Max color distance when flood-filling the background for vision_extract_foreground.'),
})

// ── Backend resolution ──────────────────────────────────────────────────
function resolveBackends(config) {
  if (Array.isArray(config.backends) && config.backends.length > 0) {
    return config.backends.map(b => {
      const preset = PRESETS[b.preset] ?? {}
      return {
        preset: b.preset,
        baseURL: (b.baseURL ?? preset.baseURL ?? '').replace(/\/+$/, ''),
        model: b.model ?? preset.model,
        apiKeyEnv: b.apiKeyEnv ?? preset.apiKeyEnv ?? 'VISION_API_KEY',
      }
    }).filter(b => b.baseURL && b.model)
  }
  // Legacy single-backend path.
  const preset = PRESETS[config.preset] ?? {}
  const single = {
    preset: config.preset,
    baseURL: (config.baseURL ?? preset.baseURL ?? '').replace(/\/+$/, ''),
    model: config.model ?? preset.model,
    apiKeyEnv: config.apiKeyEnv ?? preset.apiKeyEnv ?? 'VISION_API_KEY',
  }
  if (!single.baseURL || !single.model) {
    throw new Error('[dsh-img] no usable vision backend configured (need baseURL + model, or a preset)')
  }
  return [single]
}

/**
 * One vision call against a specific backend. Returns { answer, model }.
 * Throws on failure so the fail-over chain can walk to the next backend.
 */
async function callBackend(backend, image, question, cfg, signal) {
  const url = `${backend.baseURL}/chat/completions`
  const apiKey = process.env[backend.apiKeyEnv]
  if (!apiKey) {
    throw new Error(`no ${backend.apiKeyEnv} in environment`)
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: backend.model,
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
    const body = (await res.text()).slice(0, 300)
    throw new Error(`HTTP ${res.status}: ${body}`)
  }
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  const answer = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(part => part?.text ?? '').join('')
      : ''
  if (!answer) throw new Error('empty answer')
  return { answer, model: backend.model }
}

/**
 * Fail-over chain: try each backend in order, collect errors, return the
 * first success. Throws an aggregated error only if every backend failed.
 */
async function callVisionChain(backends, image, question, cfg, signal) {
  const errors = []
  for (const b of backends) {
    try {
      return await callBackend(b, image, question, cfg, signal)
    } catch (e) {
      errors.push(`${b.preset ?? b.model}(${b.model}): ${e?.message ?? e}`)
    }
  }
  throw new Error(`[dsh-img] all ${backends.length} vision backend(s) failed:\n- ${errors.join('\n- ')}`)
}

// ── Local pixel helpers (no API key needed) ─────────────────────────────
async function loadImageForTool(filePath, config) {
  const mime = MIME[extname(filePath).toLowerCase()]
  if (!mime) {
    throw new Error(`Unsupported image type "${extname(filePath) || '(none)'}". Supported: ${Object.keys(MIME).join(' ')}`)
  }
  const info = await stat(filePath).catch(() => {
    throw new Error(`Image not found: ${filePath}`)
  })
  const limit = (config.maxImageMB ?? 10) * 1024 * 1024
  if (info.size > limit) {
    throw new Error(`Image too large: ${(info.size / 1048576).toFixed(1)}MB exceeds the ${config.maxImageMB}MB limit`)
  }
  return { mime }
}

// ── Persistent content-addressed cache ──────────────────────────────────
let cacheDir = null
async function initCacheDir(enabled) {
  if (!enabled) return
  const dir = join(homedir(), '.dsh', 'dsh-img-cache')
  try {
    await mkdir(dir, { recursive: true })
    cacheDir = dir
  } catch {
    cacheDir = null
  }
}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
async function cacheGet(key) {
  if (cacheDir === null) return undefined
  try {
    return JSON.parse(await readFile(join(cacheDir, `${key}.json`), 'utf8'))
  } catch {
    return undefined
  }
}
async function cacheSet(key, value) {
  if (cacheDir === null) return
  try {
    await writeFile(join(cacheDir, `${key}.json`), JSON.stringify(value), 'utf8')
  } catch {
    // cache writes are best-effort
  }
}

// Walk content blocks, including nested tool-result content.
function hasImageBlock(content) {
  return Array.isArray(content) && content.some(block =>
    block?.type === 'image' || (block?.type === 'tool-result' && hasImageBlock(block.content)))
}

function dirOf(p) {
  const idx = p.lastIndexOf('/')
  return idx >= 0 ? p.slice(0, idx) || '/' : '.'
}

export function apply(ctx, config) {
  const backends = resolveBackends(config)
  const cfg = {
    detail: config.detail,
    timeoutMs: config.timeoutMs,
    maxImageMB: config.maxImageMB,
  }

  initCacheDir(config.cache !== false)

  // Read an image (by path) into { mediaType, base64, buf }.
  const readImageBytes = async (filePath) => {
    const { mime } = await loadImageForTool(filePath, config)
    const buf = await readFile(filePath)
    return { mediaType: mime, base64: buf.toString('base64'), buf }
  }

  // Shared: run a question against the vision chain, with disk cache.
  const askVision = async (image, question, signal) => {
    let key = null
    if (config.cache !== false && cacheDir !== null) {
      key = sha256(Buffer.concat([Buffer.from(image.base64), Buffer.from(question)]))
      const hit = await cacheGet(key)
      if (hit) return hit
    }
    const result = await callVisionChain(backends, image, question, cfg, signal)
    if (key) await cacheSet(key, result)
    return result
  }

  // ── analyze_image (back-compat) ───────────────────────────────────────
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
      const image = await readImageBytes(filePath)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      return await askVision(image, args.question, signal)
    },
  }))

  // ── vision_crop (local) ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_crop',
    description: [
      'Crop a region of an image to a new PNG file, purely locally (no vision API).',
      '`region` is a comma/space-separated box "x1,y1,x2,y2" in original pixels.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Source image path (absolute or workspace-relative).' },
      region: { type: 'string', required: true, description: 'Pixel box "x1,y1,x2,y2".' },
      out: { type: 'string', description: 'Output path. Defaults to <name>.crop.png beside the source.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: `cropped → ${v.path} (${v.width}x${v.height})` }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const nums = args.region.split(/[,\s]+/).map(Number)
      if (nums.length !== 4 || nums.some(n => Number.isNaN(n))) {
        throw new Error(`region must be "x1,y1,x2,y2" (got "${args.region}")`)
      }
      const [x1, y1, x2, y2] = nums
      const left = Math.min(x1, x2); const top = Math.min(y1, y2)
      const width = Math.abs(x2 - x1); const height = Math.abs(y2 - y1)
      if (width < 1 || height < 1) throw new Error('region has zero size')
      const out = args.out ?? join(dirOf(filePath), `${basename(filePath, extname(filePath))}.crop.png`)
      await sharp(filePath).extract({ left, top, width, height }).png().toFile(out)
      return { path: out, width, height }
    },
  }))

  // ── vision_pixel_diff (local) ─────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_pixel_diff',
    description: [
      'Compare two images per-pixel (after aligning to the smaller box and downsampling)',
      'and report a difference ratio plus the worst 8x8-grid regions. Outputs a red heatmap',
      'PNG. Fully local, no API key.',
    ].join(' '),
    parameters: {
      original: { type: 'string', required: true, description: 'Reference image path.' },
      rebuilt: { type: 'string', required: true, description: 'Comparison image path.' },
      out: { type: 'string', description: 'Heatmap output path. Defaults to <name>.diff.png beside original.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          diffRatio: { type: 'number' },
          changedPixels: { type: 'number' },
          totalPixels: { type: 'number' },
          worstRegions: {
            type: 'array',
            items: { type: 'object', properties: { region: { type: 'string' }, diffRatio: { type: 'number' } }, additionalProperties: false },
          },
          heatmap: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: `${(v.diffRatio * 100).toFixed(2)}% diff (${v.changedPixels}/${v.totalPixels}px), heatmap: ${v.heatmap}` }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      const aPath = isAbsolute(args.original) ? args.original : resolve(process.cwd(), args.original)
      const bPath = isAbsolute(args.rebuilt) ? args.rebuilt : resolve(process.cwd(), args.rebuilt)
      const maxEdge = config.pixelDiffSampleMax ?? 1024

      const a = sharp(aPath)
      const b = sharp(bPath)
      const am = await a.metadata(); const bm = await b.metadata()
      const W = Math.min(am.width, bm.width); const H = Math.min(am.height, bm.height)
      const scale = Math.min(1, maxEdge / Math.max(W, H))
      const w = Math.max(1, Math.round(W * scale)); const h = Math.max(1, Math.round(H * scale))

      const [ar, br] = await Promise.all([
        a.extract({ left: 0, top: 0, width: W, height: H }).resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
        b.extract({ left: 0, top: 0, width: W, height: H }).resize(w, h).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
      ])
      const ad = ar.data, bd = br.data
      const total = w * h
      const THRESH = 16

      const heat = Buffer.alloc(w * h * 3)
      let changed = 0
      for (let i = 0; i < total; i++) {
        const o = i * 3
        const d = Math.abs(ad[o] - bd[o]) + Math.abs(ad[o + 1] - bd[o + 1]) + Math.abs(ad[o + 2] - bd[o + 2])
        if (d >= THRESH * 3) {
          changed++
          heat[o] = 255; heat[o + 1] = 0; heat[o + 2] = 0
        } else {
          heat[o] = 220; heat[o + 1] = 220; heat[o + 2] = 220
        }
      }
      const diffRatio = changed / total

      const grid = []
      const GW = Math.max(1, Math.floor(w / 8)); const GH = Math.max(1, Math.floor(h / 8))
      for (let gy = 0; gy < 8; gy++) {
        for (let gx = 0; gx < 8; gx++) {
          let cnt = 0, n = 0
          for (let y = gy * GH; y < (gy + 1) * GH && y < h; y++) {
            for (let x = gx * GW; x < (gx + 1) * GW && x < w; x++) {
              const o = (y * w + x) * 3
              const d = Math.abs(ad[o] - bd[o]) + Math.abs(ad[o + 1] - bd[o + 1]) + Math.abs(ad[o + 2] - bd[o + 2])
              if (d >= THRESH * 3) cnt++
              n++
            }
          }
          if (n > 0) grid.push({ region: `(${gx},${gy})`, diffRatio: cnt / n })
        }
      }
      grid.sort((p, q) => q.diffRatio - p.diffRatio)
      const worstRegions = grid.slice(0, 6).map(g => ({ region: g.region, diffRatio: Number(g.diffRatio.toFixed(4)) }))

      const out = args.out ?? join(dirOf(aPath), `${basename(aPath, extname(aPath))}.diff.png`)
      await sharp(heat, { raw: { width: w, height: h, channels: 3 } }).png().toFile(out)
      return { diffRatio: Number(diffRatio.toFixed(4)), changedPixels: changed, totalPixels: total, worstRegions, heatmap: out }
    },
  }))

  // ── vision_colors (local) ─────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_colors',
    description: 'Extract the dominant colors of an image (hex + share) locally via sharp.',
    parameters: {
      path: { type: 'string', required: true, description: 'Image path.' },
      top: { type: 'number', description: 'How many colors to return (default 8).' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          colors: {
            type: 'array',
            items: { type: 'object', properties: { hex: { type: 'string' }, share: { type: 'number' } }, additionalProperties: false },
          },
        },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.colors.map(c => `${c.hex} ${(c.share * 100).toFixed(1)}%`).join(', ') }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const top = Math.max(1, Math.min(32, args.top ?? 8))
      const raw = await sharp(filePath).resize(128, 128, { fit: 'inside' }).removeAlpha().raw().toBuffer({ resolveWithObject: true })
      const { data, info } = raw
      const n = info.width * info.height
      const buckets = new Map()
      for (let i = 0; i < n; i++) {
        const o = i * info.channels
        const r = data[o], g = data[o + 1], b = data[o + 2]
        const key = (r << 16) | (g << 8) | b
        buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }
      const colors = [...buckets.entries()].sort((p, q) => q[1] - p[1]).slice(0, top).map(([k, cnt]) => ({
        hex: `#${(k >>> 16 & 255).toString(16).padStart(2, '0')}${(k >>> 8 & 255).toString(16).padStart(2, '0')}${(k & 255).toString(16).padStart(2, '0')}`,
        share: Number((cnt / n).toFixed(4)),
      }))
      return { colors }
    },
  }))

  // ── vision_ocr (local tesseract → vision fallback) ────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_ocr',
    description: [
      'Transcribe text in an image. Local tesseract OCR runs first (no API),',
      'then the vision backend if tesseract is missing or returns nothing usable.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Image path.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, engine: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const { mime } = await loadImageForTool(filePath, config)
      try {
        const lang = config.ocrLang || 'chi_sim+eng'
        // Resolve symlinks (macOS /tmp → /private/tmp) which leptonica cannot read.
        const realPath = await realpath(filePath)
        const { stdout } = await execFileAsync('tesseract', [realPath, 'stdout', '-l', lang], { timeout: config.timeoutMs, maxBuffer: 16 * 1024 * 1024 })
        const text = (stdout || '').trim()
        if (text) return { text, engine: `tesseract:${lang}` }
      } catch {
        // fall through to vision backend
      }
      const buf = await readFile(filePath)
      const image = { mediaType: mime, base64: buf.toString('base64') }
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      const { answer, model } = await askVision(image, '请逐字转录这张图片中的所有文字，按原文顺序输出，不要添加任何解释。', signal)
      return { text: answer, engine: `vision:${model}` }
    },
  }))

  // ── vision_ground (vision model → coordinates) ────────────────────────
  ctx.tools.register(defineTool({
    name: 'vision_ground',
    description: [
      'Locate a target object in an image and return its bounding box as',
      'original-pixel "x1,y1,x2,y2" coordinates, using the vision backend.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Image path.' },
      target: { type: 'string', required: true, description: 'What to locate, e.g. "the send button".' },
    },
    output: {
      schema: {
        type: 'object',
        properties: { box: { type: 'string' }, x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, model: { type: 'string' } },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: `box=${v.box}` }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const image = await readImageBytes(filePath)
      const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
      const { answer, model } = await askVision(
        image,
        `图中找到：${args.target}。请只返回其外接矩形框，格式严格为 "x1,y1,x2,y2"（四个整数，原始像素坐标，x1<x2 且 y1<y2），不要输出其它文字。`,
        signal,
      )
      const m = answer.match(/-?\d+\s*,\s*-?\d+\s*,\s*-?\d+\s*,\s*-?\d+/)
      if (!m) {
        throw new Error(`[dsh-img] vision_ground could not parse a box from: ${answer}`)
      }
      const [x1, y1, x2, y2] = m[0].split(',').map(Number)
      return { box: `${x1},${y1},${x2},${y2}`, x1, y1, x2, y2, model }
    },
  }))

  // ── vision_trace (local, potrace SVG vectorization) ───────────────────
  ctx.tools.register(defineTool({
    name: 'vision_trace',
    description: [
      'Vectorize a bitmap image into an SVG path (potrace posterization),',
      'purely locally — ideal for icons, logos, and line art. No API key.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Image path (png/jpg/bmp).' },
      steps: { type: 'number', description: 'Posterization color steps (default from config, e.g. 4).' },
      out: { type: 'string', description: 'Output SVG path. Defaults to <name>.svg beside the source.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          svgLength: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: `traced → ${v.path} (${v.svgLength} bytes)` }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => true,
    async execute(args) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const ext = extname(filePath).toLowerCase()
      if (!['.png', '.jpg', '.jpeg', '.bmp'].includes(ext)) {
        throw new Error(`vision_trace supports .png/.jpg/.bmp (got "${ext}")`)
      }
      const steps = args.steps ?? config.traceSteps ?? 4
      const svg = await trace(filePath, { steps: Math.max(1, steps) })
      const out = args.out ?? join(dirOf(filePath), `${basename(filePath, ext)}.svg`)
      await writeFile(out, svg, 'utf8')
      return { path: out, svgLength: svg.length }
    },
  }))

  // ── vision_extract_foreground (local, border flood fill cutout) ───────
  ctx.tools.register(defineTool({
    name: 'vision_extract_foreground',
    description: [
      'Cut out the foreground from a uniform background via border flood fill:',
      'pixels connected to the image border and close to the corner color become',
      'transparent. Outputs a transparent PNG. Fully local, no API key.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Image path (png/jpg/webp).' },
      tolerance: { type: 'number', description: 'Max color distance to treat as background (default from config).' },
      out: { type: 'string', description: 'Output PNG path. Defaults to <name>.fg.png beside the source.' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          width: { type: 'number' },
          height: { type: 'number' },
          removedPixels: { type: 'number' },
        },
        additionalProperties: false,
      },
      render: (_a, v) => [{ type: 'text', text: `cutout → ${v.path} (removed ${v.removedPixels} bg px)` }],
    },
    timeoutMs: config.timeoutMs,
    isConcurrencySafe: () => false,
    async execute(args) {
      const filePath = isAbsolute(args.path) ? args.path : resolve(process.cwd(), args.path)
      const tolerance = args.tolerance ?? config.foregroundTolerance ?? 40

      const raw = await sharp(filePath).removeAlpha().ensureAlpha().raw().toBuffer({ resolveWithObject: true })
      const { data, info } = raw
      const w = info.width, h = info.height
      const channels = info.channels // 4 (RGBA after ensureAlpha)

      // Reference background color = top-left corner pixel.
      const bg = [data[0], data[1], data[2]]

      const dist = (o) => {
        const dr = data[o] - bg[0], dg = data[o + 1] - bg[1], db = data[o + 2] - bg[2]
        return Math.sqrt(dr * dr + dg * dg + db * db)
      }

      const visited = new Uint8Array(w * h)
      const queue = []
      let removed = 0

      const tryPush = (x, y) => {
        if (x < 0 || y < 0 || x >= w || y >= h) return
        const idx = y * w + x
        if (visited[idx]) return
        visited[idx] = 1
        const o = idx * channels
        if (dist(o) <= tolerance) {
          queue.push(idx)
        }
      }

      // Seed from all border pixels.
      for (let x = 0; x < w; x++) { tryPush(x, 0); tryPush(x, h - 1) }
      for (let y = 0; y < h; y++) { tryPush(0, y); tryPush(w - 1, y) }

      while (queue.length > 0) {
        const idx = queue.pop()
        const o = idx * channels
        data[o + 3] = 0 // make transparent
        removed++
        const x = idx % w, y = (idx / w) | 0
        tryPush(x - 1, y); tryPush(x + 1, y); tryPush(x, y - 1); tryPush(x, y + 1)
      }

      const out = args.out ?? join(dirOf(filePath), `${basename(filePath, extname(filePath))}.fg.png`)
      await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toFile(out)
      return { path: out, width: w, height: h, removedPixels: removed }
    },
  }))

  // ── chat bridge ───────────────────────────────────────────────────────
  if (!config.chatBridge) return

  const llm = ctx.get('llm', false)
  const attachments = ctx.get('attachments', false)
  if (!llm || !attachments) {
    console.warn('[dsh-img] chat bridge disabled: llm/attachments service not available (tools still work)')
    return
  }

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
    console.warn('[dsh-img] could not widen model input modalities:', error?.message ?? error)
  }

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
      const { answer, model } = await askVision(
        { base64, mediaType },
        config.bridgePrompt,
        AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
      )
      text = `[图片转述 · ${model}]\n${answer}`
    } catch (error) {
      text = `[图片转述失败：${error?.message ?? error}。请检查 dsh-img 配置的 vision backend 环境变量。]`
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

  ctx.on('llm/stream', (options, next) => {
    const messages = options?.messages
    if (!Array.isArray(messages) || !messages.some(m => hasImageBlock(m?.content))) return next()

    return (async function* () {
      const signal = options.signal ?? new AbortController().signal
      const transcoded = []
      for (const message of messages) {
        if (!hasImageBlock(message?.content)) {
          transcoded.push(message)
          continue
        }
        const content = await transcodeContent(message.content, signal)
        const hasText = content.some(b => b?.type === 'text' && b.text?.trim())
        transcoded.push(message.role === 'user' && !hasText
          ? { ...message, content: [...content, { type: 'text', text: '（用户只发了图片，没有附带文字；请基于上面的图片转述理解图片并回应。）' }] }
          : { ...message, content })
      }
      yield* llm.stream({ ...options, messages: transcoded })
    })()
  })
}
