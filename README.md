# dsh-img

给纯文本模型装上眼睛，并升级成完整的本地视觉工具链 · **Give text-only models eyes** — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that bridges any text-only coding agent to a vision API, plus a set of **local, key-free pixel tools** (crop / pixel-diff / colors / OCR).

- 🇨🇳 **零成本开箱**：默认接智谱 **GLM-4V-Flash（免费）**，备选通义 **Qwen-VL（免费额度）**
- 🔁 **多后端自动回退**：配置一个 `backends` 列表，按顺序 failover，一个挂了自动切下一个
- 🧰 **本地像素工具（无需 key）**：`vision_crop` / `vision_pixel_diff` / `vision_colors` / `vision_ocr`（本地 tesseract）/ `vision_trace`（SVG 矢量化）/ `vision_extract_foreground`（抠图）完全不调视觉 API
- 💾 **识别结果缓存**：按图片内容 + 问题 hash 持久化到 `~/.dsh/dsh-img-cache/`，重复调用不重复花钱
- 📦 **npm 一键安装**：纯 JavaScript、零构建步骤
- 🔌 **任意端点**：`custom` 预设支持任何 OpenAI 兼容视觉端点（中转站 / 自建 vLLM / GPT-4o…）

## 安装（Install）

**前置条件**：Node.js ≥ 20；已装 dsh 本体（`npm i -g @deepseek-ai/dsh`，跑 `dsh web` 能开 http://127.0.0.1:3080 即可）。

**① 装插件**

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-img --registry https://registry.npmjs.org
```

并把 `dsh-img` 加进该 profile 的 `package.json` → `dsh.profile.bundles` 数组（若 `dsh plugin` 命令在你的版本可用，则 `dsh plugin --profile web add dsh-img` 会自动登记）。

**② 配 API key**（只看图问答才需要；本地工具无需 key）

```sh
export ZHIPU_API_KEY=your-key-here   # 免费申请：https://open.bigmodel.cn/
```

**③ 重启服务（key 必须注入到 dsh 进程）**

```sh
pkill -f "dsh web"
ZHIPU_API_KEY=your-key-here dsh web
```

**④ 新建会话**，直接贴图进对话框，或对 agent 说：

> 用 analyze_image 看一下 ./screenshot.png 里写了什么

## 切换后端 / 多后端回退（Backends）

编辑 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`），按 id 覆盖整行。

**单个后端**（向后兼容）：

```yaml
- id: image-bridge
  name: dsh-img
  config:
    preset: qwen        # zhipu | qwen | custom
```

**多后端回退链**（新 `backends` 字段，从左到右 failover）：

```yaml
- id: image-bridge
  name: dsh-img
  config:
    backends:
      - preset: zhipu                       # 首选（失败→下一个）
      - preset: qwen
      - preset: custom
        baseURL: https://your-gateway/v1
        model: gpt-4o
        apiKeyEnv: MY_GATEWAY_KEY
```

key 分别用 `ZHIPU_API_KEY` / `DASHSCOPE_API_KEY` / `MY_GATEWAY_KEY` 注入。

## 工具（Tools）

**需要 key（走视觉后端）**

| 工具 | 说明 |
|---|---|
| `analyze_image(path, question)` | 图片问答 / OCR / 布局理解，返回文字答案 |
| `vision_ground(path, target)` | 定位目标元素，返回原图像素坐标框 `x1,y1,x2,y2` |

**无需 key（纯本地）**

| 工具 | 说明 |
|---|---|
| `vision_crop(path, region, out?)` | 裁剪 `"x1,y1,x2,y2"` 区域，输出 PNG |
| `vision_pixel_diff(original, rebuilt, out?)` | 像素级比对：diff 比率 + 最差区域排行 + 红色热力图 |
| `vision_colors(path, top?)` | 提取主色（hex + 占比） |
| `vision_ocr(path)` | 本地 tesseract 转录（chi_sim+eng），失败自动转视觉后端 |
| `vision_trace(path, steps?, out?)` | potrace 矢量化：位图 → SVG 路径（logo/图标/线稿） |
| `vision_extract_foreground(path, tolerance?, out?)` | 边界 flood fill 抠图：均匀背景变透明，输出透明 PNG |

支持 `.png .jpg .jpeg .webp .gif .bmp`。

## 配置项（Config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `preset` | `zhipu` | 旧式单后端快捷方式（`zhipu`/`qwen`/`custom`） |
| `backends` | 无 | 新式：有序后端数组，从左到右 failover（优先于 `preset`） |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageMB` | `10` | 图片大小上限 |
| `detail` | `auto` | `auto` / `low` / `high` |
| `chatBridge` | `true` | 对话框直发图：声明图片输入 + 请求前把附件转译成文字 |
| `bridgePrompt` | 内置 | 附件转译时发给视觉模型的问题 |
| `cache` | `true` | 识别结果持久化缓存（`~/.dsh/dsh-img-cache/`） |
| `ocrLang` | `chi_sim+eng` | 本地 OCR 的 tesseract 语言包 |
| `pixelDiffSampleMax` | `1024` | pixel-diff 降采样最长边（控制 CPU） |
| `traceSteps` | `4` | `vision_trace` 的 posterize 颜色层数 |
| `foregroundTolerance` | `40` | `vision_extract_foreground` 的背景色容差（越大抠得越狠） |

## 排错（Troubleshooting）

| 报错 | 原因与解法 |
|---|---|
| `all N vision backend(s) failed` | 回退链里每个后端都失败；检查各 key 环境变量是否注入 dsh 进程 |
| `Vision API HTTP 401` | key 错误或未开通对应模型 |
| `Unsupported image type` | 转了不支持的格式；先转成 png/jpg |
| `Image too large` | 超过 `maxImageMB`；调大配置或压缩图片 |
| `vision_ground could not parse a box` | 视觉模型没按格式返回坐标；换模型或用更明确的目标描述 |
| 所有工具调用崩 `reading 'prepare'` | 装的是 ≤0.2.3 旧版（双实例 bug）；`pnpm add dsh-img@latest` 升级 |
| 贴图后模型答非所问 | 检查图里是否有旧指令文字——模型会把图中文字当上下文读 |
| 旧会话持续报 tool_calls 错 | 该会话已被旧 bug 毒化（append-only 日志），新建会话即可 |

## English

A zero-build plugin for DeepSeek Harness. One command to install, one env var to configure, and your text-only model gains image understanding through `analyze_image` — plus key-free local tools (`vision_crop`, `vision_pixel_diff`, `vision_colors`, `vision_ocr`, `vision_trace`, `vision_extract_foreground`) and an ordered multi-backend failover chain.

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-img --registry https://registry.npmjs.org
export ZHIPU_API_KEY=...   # free at https://open.bigmodel.cn/
```

## License

MIT
