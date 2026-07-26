# pi-relay-models

[中文](README.md)

A mixed-protocol relay extension for [pi](https://github.com/earendil-works/pi-mono). It discovers relay models, reuses metadata from pi's official catalog, and selects OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages per model within one provider.

## Features

- Discovers model IDs from a compatible `/models` endpoint.
- Reuses official names, reasoning capabilities, input modalities, pricing, context windows, output limits, thinking maps, and compatibility settings by exact model ID.
- Routes Claude models through Anthropic Messages, newer OpenAI models through Responses, and other models through Chat Completions by default.
- Adds unmatched models with conservative fallback metadata and suggests nearby official candidates for review.
- Persists user-approved metadata mappings, per-model protocol overrides, and model exclusions.
- Keeps API keys in pi's `/login` credential flow, outside AI context and extension configuration.
- Centralizes optional Claude/Codex request-header profiles.

## Requirements

- pi `0.82.1` or newer
- Node.js `22.6` or newer
- An OpenAI- or Anthropic-compatible relay that exposes a model list

## Installation

Install from GitHub:

```bash
pi install git:github.com/Xichun123/pi-relay-models
```

Then reload pi:

```text
/reload
```

Do not keep a manually installed `~/.pi/agent/extensions/relay-models/` copy at the same time, because the tools and commands would be registered twice.

To try the extension without changing settings:

```bash
pi -e git:github.com/Xichun123/pi-relay-models
```

## Usage

Start the interactive setup:

```text
/relay-add
```

The wizard creates a provider and prompts you to run:

```text
/login <provider-id>
```

Enter the API key only in `/login`'s secret prompt. Never send it in chat. After login, use:

```text
/relay-sync
/relay-list
```

The extension also registers a `relay_models` AI tool with these actions:

| Action | Purpose |
| --- | --- |
| `add` | Add or update a relay provider |
| `sync` | Refresh models and match official metadata |
| `status` | Inspect provider, matching, and routing status |
| `map` | Save a user-approved official metadata mapping |
| `protocol` | Override one model's protocol |
| `exclude` | Persistently exclude a model |
| `include` | Restore an excluded model |

`map`, `protocol`, and `exclude` are persistent changes. The tool instructions require explicit user approval before invoking them.

## Mixed-protocol routing

Each relay provider registers all three APIs:

- `anthropic-messages`
- `openai-responses`
- `openai-completions`

When an official catalog match exists, the extension infers the protocol from that model. A manual protocol override has the highest priority. Unmatched models use the provider fallback protocol.

For Anthropic models, a trailing `/v1` is removed from the Base URL to prevent SDK requests to `/v1/v1/messages`.

## Configuration and credentials

The extension uses pi's agent directory and maintains:

- `relay-providers.json`: provider URLs, mappings, protocol overrides, and exclusions; mode `0600`
- `models-store.json`: model cache managed by pi
- `auth.json`: credentials managed by pi's `/login`

`relay-providers.json` never contains API keys. Do not commit these local files.

## Header profiles

Fixed request headers are centralized in:

```text
extensions/relay-models/header-profiles.ts
```

Default routing:

- Anthropic Messages uses `claude`, or `claudeLongContext` at a 1M context window
- OpenAI Chat Completions uses `claude`
- OpenAI Responses uses `codex`

These profiles are intended for relays that require client-specific compatibility headers. Verify your endpoint's terms and compatibility before use. Never add Authorization, cookies, or API keys to this file.

## Development

```bash
npm install
npm run validate
```

The tests only start a temporary local HTTP server and do not call a real relay.

## License

[MIT](LICENSE)
