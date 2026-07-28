# pi-relay-models

[English](README.en.md)

一个用于 [pi](https://github.com/earendil-works/pi-mono) 的混合协议中转站扩展。它自动发现中转站模型，复用 pi 官方模型目录中的元信息，并在同一个 Provider 内按模型选择 OpenAI Chat Completions、OpenAI Responses 或 Anthropic Messages。

## 功能

- 从兼容端点的 `/models` 自动发现模型 ID。
- 按精确模型 ID 复用 pi 官方名称、推理能力、输入模态、价格、上下文窗口、最大输出、thinking map 和兼容性配置。
- Claude 模型使用 Anthropic Messages，OpenAI 新模型使用 Responses，其他模型默认使用 Chat Completions。
- 未匹配模型使用保守默认元信息，并提供相近的官方候选供人工确认。
- 持久保存人工元信息映射、单模型协议覆盖和排除规则。
- API Key 只通过 pi 的 `/login` 管理，不进入 AI 上下文或扩展配置。
- 可集中配置 Claude/Codex 请求头配置文件。

## 要求

- pi `0.82.1` 或更高版本
- Node.js `22.6` 或更高版本
- 中转站提供 OpenAI 或 Anthropic 兼容 API，并能返回模型列表

## 安装

从 npm 安装（推荐）：

```bash
pi install npm:pi-relay-models
```

安装完成后，在 pi 中运行：

```text
/reload
```

不要同时保留手动安装的 `~/.pi/agent/extensions/relay-models/` 副本，否则工具和命令会重复注册。

临时试用而不写入设置：

```bash
pi -e npm:pi-relay-models
```

## 使用

运行交互向导：

```text
/relay-add
```

向导会创建 Provider，并提示执行：

```text
/login <provider-id>
```

请只在 `/login` 的秘密输入框中输入 API Key，不要将 API Key 发送到聊天。登录后可运行：

```text
/relay-sync
/relay-list
```

也可以直接让 AI 添加、同步或检查中转站。扩展注册了 `relay_models` 工具，支持：

| 操作 | 作用 |
| --- | --- |
| `add` | 添加或更新中转站 Provider |
| `sync` | 刷新模型并匹配官方元信息 |
| `status` | 查看供应商、匹配和路由状态 |
| `map` | 保存人工确认的官方元信息映射 |
| `protocol` | 覆盖单个模型的协议 |
| `exclude` | 持久排除一个或多个模型 |
| `include` | 恢复一个或多个已排除模型 |

`exclude` 和 `include` 可使用 `remoteModelId` 操作单个模型，或使用 `remoteModelIds` 数组批量操作。批量操作只保存一次配置并刷新一次模型列表；原有单模型参数保持兼容。

`map`、`protocol` 和 `exclude` 属于持久配置变更，AI 工具说明要求在调用前取得用户明确确认。

## 混合协议路由

每个中转站 Provider 同时注册三种 API：

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

匹配到官方目录后，扩展根据官方模型来源选择协议。人工协议覆盖的优先级最高；未匹配模型使用 Provider 的回退协议。

Anthropic 模型会自动移除 Base URL 末尾的 `/v1`，避免 SDK 生成重复的 `/v1/v1/messages` 路径。

## 配置和凭据

扩展使用 pi 的 agent 目录，并维护：

- `relay-providers.json`：供应商 URL、映射、协议覆盖和排除规则，权限为 `0600`
- `models-store.json`：由 pi 管理的模型缓存
- `auth.json`：由 pi `/login` 管理的凭据

`relay-providers.json` 不包含 API Key。不要提交上述本地文件。

## 请求头配置

固定请求头集中在：

```text
extensions/relay-models/header-profiles.ts
```

默认路由：

- Anthropic Messages 使用 `claude`，上下文窗口达到 1M 时使用 `claudeLongContext`
- OpenAI Chat Completions 使用 `claude`
- OpenAI Responses 使用 `codex`

这些配置用于适配要求特定客户端请求头的中转站。使用前请确认端点条款和兼容性。不要在该文件中加入 Authorization、Cookie 或 API Key。

## 开发

```bash
npm install
npm run validate
```

测试只启动本机临时 HTTP 服务，不访问真实中转站。

## 许可证

[MIT](LICENSE)
