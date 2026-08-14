# dsh-image-bridge

给纯文本模型装上眼睛 · **Give text-only models eyes** — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds an `analyze_image` tool, bridging any text-only coding agent to a vision API.

- 🇨🇳 **零成本开箱**：默认接智谱 **GLM-4V-Flash（免费）**，备选通义 **Qwen-VL（免费额度）**
- 📦 **npm 一键安装**：纯 JavaScript、零构建步骤（对比 GitHub 源码类插件的手动构建）
- 🔌 **任意端点**：`custom` 预设支持任何 OpenAI 兼容视觉端点（中转站 / 自建 vLLM / GPT-4o…）

## 安装（Install）

```sh
dsh plugin --profile web add dsh-image-bridge
# 重启 dsh web / Restart the server
```

设置 API key（智谱免费申请：https://open.bigmodel.cn/ ）：

```sh
export ZHIPU_API_KEY=your-key-here
```

然后对 agent 说：

> 用 analyze_image 看一下 ./screenshot.png 里写了什么

## 切换后端（Switch backend）

编辑 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`），按 id 覆盖整行：

```yaml
- id: image-bridge
  name: dsh-image-bridge
  config:
    preset: qwen        # zhipu | qwen | custom
```

通义 key 用 `export DASHSCOPE_API_KEY=...`。

**自定义端点（中转站等）**：

```yaml
- id: image-bridge
  name: dsh-image-bridge
  config:
    preset: custom
    baseURL: https://your-gateway/v1
    model: gpt-4o
    apiKeyEnv: MY_GATEWAY_KEY
```

## 配置项（Config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `preset` | `zhipu` | `zhipu`(GLM-4V-Flash 免费) / `qwen`(Qwen-VL 免费额度) / `custom` |
| `baseURL` | 预设值 | OpenAI 兼容端点；`custom` 必填 |
| `model` | 预设值 | 视觉模型 id |
| `apiKeyEnv` | 预设值 | 存放 key 的环境变量名 |
| `timeoutMs` | `60000` | 单次请求超时 |
| `maxImageMB` | `10` | 图片大小上限 |
| `detail` | `auto` | `auto` / `low` / `high` |

## 工具（Tool）

**`analyze_image(path, question)`**

- `path`：图片绝对路径，或相对工作区根目录的路径
- `question`：要从图里得到什么（OCR / 布局 / UI 还原 / 图表解读…）
- 返回视觉模型的文字答案，进纯文本模型的上下文

支持 `.png .jpg .jpeg .webp .gif .bmp`。

## 排错（Troubleshooting）

| 报错 | 原因与解法 |
|---|---|
| `Vision API key not found` | 没设环境变量；按上方设置 `ZHIPU_API_KEY` 或改 `apiKeyEnv` |
| `Vision API HTTP 401` | key 错误或未开通对应模型 |
| `Unsupported image type` | 转了不支持的格式；先转成 png/jpg |
| `Image too large` | 超过 `maxImageMB`；调大配置或压缩图片 |

## English

A zero-build plugin for DeepSeek Harness. One command to install, one env var to configure, and your text-only model (e.g. DeepSeek's chat route) gains image understanding through the `analyze_image` tool. Ships with free Chinese vision backends (Zhipu GLM-4V-Flash, Qwen-VL) and a `custom` preset for any OpenAI-compatible endpoint.

```sh
dsh plugin --profile web add dsh-image-bridge
export ZHIPU_API_KEY=...   # free at https://open.bigmodel.cn/
```

## License

MIT
