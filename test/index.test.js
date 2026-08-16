import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import sharp from 'sharp'
import { apply } from '../index.js'

// Build a fake ctx that captures registered tools and neuters chat bridge.
function makeCtx() {
  const tools = {}
  const ctx = {
    tools: { register: (t) => { tools[t.name] = t } },
    get: () => null,       // no llm/attachments → chat bridge off
    on: () => {},
  }
  return { ctx, tools }
}

function baseConfig(overrides = {}) {
  return Object.assign({
    preset: 'zhipu',
    timeoutMs: 30000,
    maxImageMB: 10,
    chatBridge: false,
    cache: false,
    ocrLang: 'eng',
    pixelDiffSampleMax: 256,
    traceSteps: 4,
    foregroundTolerance: 60,
  }, overrides)
}

const exec = { signal: new AbortController().signal }

async function makeImg(w, h, red, green, blue) {
  return await sharp({ create: { width: w, height: h, channels: 3, background: { r: red, g: green, b: blue } } })
    .png().toBuffer()
}

let dir
test.before(async () => { dir = await mkdtemp(join(tmpdir(), 'dsh-img-test-')) })
test.after(async () => { await rm(dir, { recursive: true, force: true }) })

test('registers all 8 tools', () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  assert.deepEqual(
    Object.keys(tools).sort(),
    ['analyze_image', 'vision_colors', 'vision_crop', 'vision_extract_foreground', 'vision_ground', 'vision_ocr', 'vision_pixel_diff', 'vision_trace'].sort(),
  )
})

test('vision_crop crops a region', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  const src = join(dir, 'a.png')
  await writeFile(src, await makeImg(100, 80, 30, 100, 200))
  const r = await tools.vision_crop.execute({ path: src, region: '0,0,50,40' }, exec)
  assert.equal(r.width, 50)
  assert.equal(r.height, 40)
  const meta = await sharp(r.path).metadata()
  assert.equal(meta.width, 50)
  assert.equal(meta.height, 40)
})

test('vision_pixel_diff reports a known change ratio', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  const a = join(dir, 'a.png')
  const b = join(dir, 'b.png')
  await writeFile(a, await makeImg(100, 80, 30, 100, 200))
  // b = same blue but bottom-right 20x20 red patch → 5% diff
  const base = await makeImg(100, 80, 30, 100, 200)
  const patch = await sharp({ create: { width: 20, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer()
  const composed = await sharp(base).composite([{ input: patch, left: 80, top: 60 }]).png().toBuffer()
  await writeFile(b, composed)
  const r = await tools.vision_pixel_diff.execute({ original: a, rebuilt: b }, exec)
  assert.ok(Math.abs(r.diffRatio - 0.05) < 0.03, `diffRatio ${r.diffRatio} ≈ 0.05`)
  assert.equal(r.changedPixels, 400) // 20*20
})

test('vision_colors returns dominant color of a solid image', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  const src = join(dir, 'solid.png')
  await writeFile(src, await makeImg(50, 50, 30, 100, 200))
  const r = await tools.vision_colors.execute({ path: src, top: 3 }, exec)
  assert.equal(r.colors.length, 1)
  assert.equal(r.colors[0].hex, '#1e64c8')
  assert.ok(Math.abs(r.colors[0].share - 1.0) < 0.001)
})

test('vision_trace produces an SVG', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  const src = join(dir, 'logo.png')
  // black circle on white
  const white = await makeImg(100, 100, 255, 255, 255)
  const black = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
  const img = await sharp(white).composite([{ input: black, left: 30, top: 30 }]).png().toBuffer()
  await writeFile(src, img)
  const r = await tools.vision_trace.execute({ path: src }, exec)
  assert.ok(r.svgLength > 0)
  await assert.doesNotReject(async () => { await stat(r.path) })
})

test('vision_extract_foreground removes uniform background', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, baseConfig())
  const src = join(dir, 'fg.png')
  // black circle on white — flood from border should remove white
  const white = await makeImg(100, 100, 255, 255, 255)
  const black = await sharp({ create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer()
  const img = await sharp(white).composite([{ input: black, left: 30, top: 30 }]).png().toBuffer()
  await writeFile(src, img)
  const r = await tools.vision_extract_foreground.execute({ path: src }, exec)
  // 100*100=10000 px, black 40*40=1600 → removed ≈ 8400 (±tolerance)
  assert.ok(r.removedPixels > 7000 && r.removedPixels < 9000, `removed ${r.removedPixels}`)
})

test('failover chain skips a failing backend', async () => {
  // mock fetch: first backend 401, second returns a canned answer
  const origFetch = globalThis.fetch
  globalThis.fetch = async (url, opts) => {
    const auth = opts.headers?.authorization
    if (url.includes('backend1')) {
      return { ok: false, status: 401, text: async () => '{"error":"unauthorized"}' }
    }
    // backend2: assert no auth (key-free local)
    assert.equal(auth, undefined, 'key-free backend must not send Authorization')
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'it is a cat' } }] }) }
  }
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, baseConfig({
      backends: [
        { preset: 'custom', baseURL: 'https://backend1.example/v1', model: 'm1', apiKeyEnv: 'MISSING' },
        { preset: 'custom', baseURL: 'https://backend2.example/v1', model: 'm2', apiKeyEnv: null },
      ],
    }))
    const src = join(dir, 'x.png')
    await writeFile(src, await makeImg(10, 10, 0, 0, 0))
    const r = await tools.analyze_image.execute({ path: src, question: 'what is it' }, exec)
    assert.equal(r.answer, 'it is a cat')
    assert.equal(r.model, 'm2')
  } finally {
    globalThis.fetch = origFetch
  }
})

test('ollama preset resolves key-free', async () => {
  const origFetch = globalThis.fetch
  let sawAuth = null
  globalThis.fetch = async (url, opts) => {
    sawAuth = opts.headers?.authorization ?? null
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'local answer' } }] }) }
  }
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, baseConfig({ preset: 'ollama' }))
    const src = join(dir, 'y.png')
    await writeFile(src, await makeImg(10, 10, 0, 0, 0))
    const r = await tools.analyze_image.execute({ path: src, question: 'q' }, exec)
    assert.equal(r.model, 'minicpm-v:8b')
    assert.equal(sawAuth, null, 'ollama must be key-free')
  } finally {
    globalThis.fetch = origFetch
  }
})
