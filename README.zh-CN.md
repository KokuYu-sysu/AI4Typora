# AI4Typora

[English](README.md) | [简体中文](README.zh-CN.md)

`AI4Typora` 是面向 Windows 的 Typora 社区插件，将 AI 润色、问答和图片问答集成到 Typora 中，无需修改 Typora 安装文件。

主要功能：

- 使用 `Ctrl + R` 或 `Ctrl + Shift + R` 润色选中文本
- 使用 `Ctrl + E` 进行写作问答
- 支持 ChatGPT OAuth 和 OpenAI 兼容 API
- 支持图片问答及多轮对话

## 功能

- `AI Optimize (Selection Only)`：仅根据选中文本润色
- `AI Optimize (Use Full Document Context)`：结合全文上下文润色选中文本
- `AI Q&A`：通过 `Ctrl + E` 对文本或图片进行多轮问答
- 支持简体中文和英文界面，可自动检测浏览器语言，也可在设置中手动选择
- 在 Typora 社区插件设置页配置服务商、模型及提示词
- 提供快捷键提示面板
- 自动检测 Windows 上的 OAuth token 文件
- 支持 OpenAI 兼容 API 和自动故障切换
- ChatGPT OAuth 和 OpenAI 兼容 API 均支持流式输出
- 响应窗口可拖动
- 选中文本润色提供本地 Diff 预览、重新生成和一键替换
- 按文档保存多轮文本/图片对话，支持显式恢复历史会话
- 默认提示词包含适配 Typora 的 Markdown 与数学公式格式规则
- 支持在 Typora 的 CodeMirror 代码编辑区润色和替换选区

## 系统要求

- Windows 11
- Typora
- [typora-community-plugin](https://github.com/typora-community-plugin/typora-community-plugin)
- 开发环境建议使用 Node.js `>= 22`

## 安装

### 1. 安装 Typora Community Plugin Framework

请先安装并确保社区插件框架可正常使用。常见运行目录为：

```text
C:\Users\<YourUser>\.typora\community-plugins
```

插件目录为：

```text
C:\Users\<YourUser>\.typora\community-plugins\plugins\AI4Typora
```

### 2. 复制或克隆插件

可以手动复制，也可以直接克隆到框架的 `plugins` 目录：

```powershell
cd C:\Users\<YourUser>\.typora\community-plugins\plugins
git clone https://github.com/KokuYu-sysu/AI4Typora.git
```

手动安装时，将整个 `AI4Typora` 文件夹复制到框架的 `plugins` 目录。

### 3. 重启 Typora

重启后：

1. 按 `Ctrl + .`
2. 打开 `Community Plugins`
3. 启用 `AI4Typora`

## 配置

打开 `Ctrl + .` -> `Community Plugins` -> `AI4Typora`。

在 `Interface Language` 中选择 English 或简体中文。设置页也可以填写服务商支持的准确模型 ID。

![设置页中的界面语言和服务商选项](asset/setting.png)

### 服务商 1：ChatGPT OAuth 登录

此模式会读取电脑上已有的 OAuth token 文件。

也可以点击 `OAuth Login`，再点击 `Download User Info`，通过浏览器连接 OpenAI 和 Typora。

自动检测顺序：

```text
%APPDATA%\oauth-cli-kit\auth\codex.json
%LOCALAPPDATA%\oauth-cli-kit\auth\codex.json
%USERPROFILE%\.codex\auth.json
```

也可以在设置页手动填写 `OAuth Token File Path`。

### 服务商 2：OpenAI 兼容 API

需要配置：

- `Base URL`
- `API Key`
- `Model`

可以连接 OpenAI 兼容网关或自托管后端。自 1.3.0 起支持通过 `api_key` 和 `base_url` 使用 DeepSeek 等其他兼容模型。

自动故障切换由 `Enable automatic fallback to backup API connections` 控制。可以在此区域配置可选的 `Backup API 1` 和 `Backup API 2` 地址、密钥和模型。

## 使用方法

### 润色选中文本

1. 在编辑器中选择文本。
2. 按 `Ctrl + R` 润色选区，或按 `Ctrl + Shift + R` 结合全文上下文润色选区。

自 1.4.0 起，文本润色改为使用快捷键：`Ctrl + R` 润色选区，`Ctrl + Shift + R` 结合全文上下文润色。更早版本曾在选中文本的右键菜单中提供这些操作；现在该菜单不再用于文本润色。对图片点击右键仍可使用图片问答。

插件会打开 Diff 对话框，并在生成过程中保留原始选区供对照。删除内容显示为删除线，新增内容显示为插入内容；未改变的上下文可折叠以便阅读。

ChatGPT OAuth 和 OpenAI 兼容服务的响应都会逐步显示。生成完成、用户停止生成或校验失败后，可以复制结果。如果用户停止生成，或全文上下文润色的公式校验失败，候选内容仍可查看和复制，但不能替换原文。

生成完成后，可以点击 `Replace` 一次性替换、点击 `Copy` 复制，或点击 `Regenerate` 重新生成。重新生成始终使用最初捕获的选区和指令，不会基于上一次的候选结果继续改写；Diff 窗口会保持打开。

点击 `Stop` 后，部分响应仍会显示，但只能复制、重新生成或关闭，不能应用到文档。如果生成期间选区或当前文件发生变化，插件会拒绝替换，并在 Diff 窗口中说明原因。替换选区前必须先保存文档。

Diff 算法由本地 JavaScript 实现，不需要 Python、Diff 依赖包或网络请求。算法支持 Unicode，并在选区中将公式片段作为不可拆分的整体处理。

Diff 窗口会保留候选内容，直到替换、复制、重新生成或关闭：

![选区润色的本地 Diff 预览](asset/Revisement.png)

### 写作问答

1. 聚焦编辑器，可选择文本，也可以不选择。
2. 按 `Ctrl + E`。
3. 输入问题。
4. 可以输入 `YES`，将全文作为上下文。

回答可以插入文档。每次打开对话窗口都会从空白草稿开始；只有发送第一条非空问题时才会创建会话记录和 `session_id`。侧栏会列出已有会话，但只有在用户明确选择后才会恢复。点击 `New` 始终创建新的空白草稿。

每条 AI 回复都有独立的 `Copy` 和 `Insert` 操作；插入回复不会关闭对话窗口。对话窗口在每次回复后保持打开，可继续追问，包括针对图片提问的后续问题。

聊天历史保存在 Windows 的以下位置：

```text
%APPDATA%\typora-ai-edit\chat-history-v1.json
%APPDATA%\typora-ai-edit\chat-assets\
```

历史记录有容量限制：每个文档最多 100 个会话，每个会话最多 200 条消息，全局最多 100 MB，每张图片最多 20 MB。达到限制时，较早完成的会话或消息可能会被清理。设置页可以清空当前文件或全部聊天历史；也可以在历史侧栏中删除单个会话。清除操作会显示确认对话框。

![多轮 AI 对话和按文件保存的历史记录](asset/AI_Q&A.png)

### 图片问答

在图片上点击右键，选择图片问答操作：

![在图片右键菜单中选择 AI 图片问答](asset/ImageQA.png)

在对话面板中输入问题：

![AI 对图片问题的回答](asset/ImageA.png)

可以复制回答或将回答插入文档。

## 默认行为

- 文本润色通过 `Ctrl + R` 或 `Ctrl + Shift + R` 启动；1.4.0 以前版本的选中文本右键润色入口已移除。
- 在图片上点击右键可以打开图片问答，或打开 Typora 原生图片菜单。
- 编辑器获得焦点时，`Ctrl + E` 可启动问答，无论是否选择了文本。
- 内置默认角色是一位资深语言学专家和专业编辑，关注语法、语义、语用与语域、术语一致性及跨语言表达。
- 修改内置默认提示词不会覆盖用户已自定义或导入的提示词。
- 默认提示词根据浏览器语言选择中文或英文；所有提示词都可以编辑。
- `Ctrl + E` 会使用当前编辑器上下文：光标位于图片目标时启动图片对话，位于文本选区或插入点时启动文本对话。

聊天记录和请求需要文档已保存。未保存的文档无法创建或恢复持久会话、保存图片，或安全地替换捕获的文本。使用这些功能前请先保存文档。

### 全文上下文润色与公式保护

`AI Optimize (Use Full Document Context)` 会在发送请求前保护待润色选区中的公式；行内代码和围栏代码块中的公式不作保护。可识别 `$...$`、`$$...$$`、`\(...\)` 和 `\[...\]`，生成后恢复原公式文本。全文只作为未修改的上下文提供，不会整体改写或用于替换。

替换前会校验每个精确公式占位符是否只出现一次且顺序不变。占位符缺失、重复、被修改或顺序变化时，会禁用 `Replace`，但候选内容仍可查看和复制。

启用 OpenAI 兼容 API 故障切换后，如果某个连接失败，其部分流式输出会在展示下一个服务商结果前清空，不会把不同请求的输出拼接在一起。

## 快捷键

| 快捷键 | 功能 |
| --- | --- |
| `Ctrl + E` | 编辑器聚焦时打开 `AI Q&A`（默认，可配置） |
| `Ctrl + R` | `AI Optimize (Selection Only)` |
| `Ctrl + Shift + R` | `AI Optimize (Use Full Document Context)` |
| `Ctrl + C` | 仅在通用流式输出窗口中复制并关闭 |
| `Ctrl + Enter` | 仅在通用流式输出窗口中确认替换或插入 |

局部润色的 Diff 窗口使用其中的 `Copy`、`Regenerate`、`Replace` 和 `Close` 按钮。复制不会关闭 Diff 窗口；按 `Escape` 关闭。`Ctrl + C` 和 `Ctrl + Enter` 在 Diff 窗口中不会触发复制或替换。问答快捷键可以在插件设置中修改，Typora 中的快捷键提示面板会显示当前按键。

![Typora 编辑区与快捷键提示](asset/overview.png)

## 开发说明

主要文件：

- `main.js`
- `manifest.json`
- `src/plugin.js`
- `src/platform.js`
- `src/api.js`
- `src/settings-tab.js`
- `src/config.js`
- `src/i18n.js`
- `src/typora-format.js`
- `src/ui.js`
- `src/editor.js`

## 已知限制

- 插件依赖 Typora Community Plugin Framework 的内部实现。
- 通过对话直接插入可能会引起错误，更推荐使用复制粘贴的形式。

## 发布包

建议上传到 GitHub 的插件目录就是仓库目录本身：

```text
AI4Typora/
```

将该目录放入 Typora 社区插件的 `plugins` 目录即可。

## 更新记录

- 0.1.0：首次发布
- 1.1.0：更新操作逻辑，添加快捷键、优化表达并增加登录按钮
- 1.2.0：修复登录相关问题，增加提示词导入/导出功能，便于迁移
- 1.3.0：支持使用 OpenAI 兼容接口
- 1.4.0：支持 AI 图片问答
- 1.5.0：增加流式输出；加入资深语言学专家和专业编辑默认角色，同时保留自定义提示词；支持全文上下文公式保护与占位符精确校验；停止生成或校验失败时保留可复制的部分结果并禁用替换；增加安全替换和重新生成的本地 Diff 预览，以及按文件保存、可显式恢复且有容量限制的多轮文本/图片聊天；新增中英文界面选择、快捷键提示面板、适配 Typora 的 Markdown/公式输出规则和 CodeMirror 代码块选区润色。

## 许可证

MIT
