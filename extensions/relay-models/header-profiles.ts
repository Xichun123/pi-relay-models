import type { SpoofHeaderProfiles } from "./core.ts";

/**
 * Single edit point for relay request-header impersonation.
 *
 * These headers are applied as follows:
 * - anthropic-messages: claude (or claudeLongContext at 1M+ context)
 * - openai-completions: claude
 * - openai-responses: codex
 *
 * Never add credentials (Authorization, Cookie, API keys) here.
 */
export const SPOOF_HEADER_PROFILES = {
	claude: {
		"user-agent": "claude-cli/2.1.198 (external, sdk-cli)",
		"x-app": "cli",
		"anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14",
	},
	claudeLongContext: {
		"user-agent": "claude-cli/2.1.198 (external, sdk-cli)",
		"x-app": "cli",
		"anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14",
	},
	codex: {
		"user-agent": "codex_cli_rs/0.144.1 (Mac OS 15.7.7; arm64) ghostty/1.3.1",
	},
} satisfies SpoofHeaderProfiles;
