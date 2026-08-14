# dsh-img

给纯文本模型装上眼睛 · **Give text-only models eyes** — a [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds an `analyze_image` tool, bridging any text-only coding agent to a vision API.

- 🇨🇳 **零成本开箱**：默认接智谱 **GLM-4V-Flash（免费）**，备选通义 **Qwen-VL（免费额度）**
- 📦 **npm 一键安装**：纯 JavaScript、零构建步骤（对比 GitHub 源码类插件的手动构建）
- 🔌 **任意端点**：`custom` 预设支持任何 OpenAI 兼容视觉端点（中转站 / 自建 vLLM / GPT-4o…）

## 安装（Install）

**前置条件**：Node.js ≥ 20；已装 dsh 本体（`npm i -g @deepseek-ai/dsh`，跑 `dsh web` 能开 http://127.0.0.1:3080 即可）；智谱免费 key 一分钟申请：https://open.bigmodel.cn/

**① 装插件（一条命令）**

```sh
dsh plugin --profile web add dsh-img
```

它会在 `~/.dsh/profiles/web/` 里执行 pnpm 安装并登记 bundle。如果报"找不到版本"，是 npm 镜像同步延迟，绕开镜像走官方源：

```sh
cd ~/.dsh/profiles/web && pnpm add dsh-img --registry https://registry.npmjs.org
```

**② 配 API key**

```sh
export ZHIPU_API_KEY=your-key-here   # 写进 ~/.zshrc 才持久
```

**③ 重启服务（key 必须注入到 dsh 进程）**

```sh
pkill -f "dsh web"
ZHIPU_API_KEY=your-key-here dsh web
```

**④ 新建会话**，直接贴图进对话框，或对 agent 说：

> 用 analyze_image 看一下 ./screenshot.png 里写了什么

## 切换后端（Switch backend）

编辑 profile 的 `cordis.patch.yml`（`$DSH_HOME/profiles/web/cordis.patch.yml`），按 id 覆盖整行：

```yaml
- id: image-bridge
  name: dsh-img
  config:
    preset: qwen        # zhipu | qwen | custom
```

通义 key 用 `export DASHSCOPE_API_KEY=...`。

**自定义端点（中转站等）**：

```yaml
- id: image-bridge
  name: dsh-img
  config:
    preset: custom
    baseURL: https://your-gateway/v1
    model: gpt-4o
    apiKeyEnv: MY_GATEWAY_KEY
```

## 两种用法（Two ways to see）

**① 对话框直接发图（0.2.0+，默认开启）**——直接把图片贴进 dsh web 对话框即可。插件会把附件图片先转译成文字描述，再交给纯文本模型。看到"当前模型不支持图片"是 0.1.x 的旧行为，升级后不会再出现。

**② `analyze_image` 工具**——让 agent 读磁盘上的图片文件（headless / SDK / 子代理场景也能用）：

> 用 analyze_image 看一下 ./screenshot.png 里写了什么

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
| `chatBridge` | `true` | 对话框直发图：声明图片输入能力 + 请求前把附件转译成文字 |
| `bridgePrompt` | 内置 | 附件转译时发给视觉模型的问题 |

## 工具（Tool）

**`analyze_image(path, question)`**

- `path`：图片绝对路径，或相对工作区根目录的路径
- `question`：要从图里得到什么（OCR / 布局 / UI 还原 / 图表解读…）
- 返回视觉模型的文字答案，进纯文本模型的上下文

支持 `.png .jpg .jpeg .webp .gif .bmp`。

## 排错（Troubleshooting）

| 报错 | 原因与解法 |
|---|---|
| `Vision API key not found` | key 没注入 dsh 进程；按上方第三步带 key 重启 |
| `Vision API HTTP 401` | key 错误或未开通对应模型 |
| `Unsupported image type` | 转了不支持的格式；先转成 png/jpg |
| `Image too large` | 超过 `maxImageMB`；调大配置或压缩图片 |
| 所有工具调用崩 `reading 'prepare'` | 装的是 ≤0.2.3 旧版（双实例 bug）；`pnpm add dsh-img@latest` 升级 |
| 贴图后模型答非所问 | 检查图里是否有旧指令文字——模型会把图中文字当上下文读 |
| 旧会话持续报 tool_calls 错 | 该会话已被旧 bug 毒化（append-only 日志），新建会话即可 |

## English

A zero-build plugin for DeepSeek Harness. One command to install, one env var to configure, and your text-only model (e.g. DeepSeek's chat route) gains image understanding through the `analyze_image` tool. Ships with free Chinese vision backends (Zhipu GLM-4V-Flash, Qwen-VL) and a `custom` preset for any OpenAI-compatible endpoint.

```sh
dsh plugin --profile web add dsh-img
export ZHIPU_API_KEY=...   # free at https://open.bigmodel.cn/
```

## License

MIT
