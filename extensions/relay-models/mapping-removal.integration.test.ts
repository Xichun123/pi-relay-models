import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CapturedTool {
	execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
	renderResult?(...args: unknown[]): { render(width: number): string[] };
}

test("unmap removes selected mappings and clear restores automatic protocols", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-relay-models-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "relay-providers.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "relay-clear",
					name: "Clear Relay",
					baseUrl: "https://clear.example/v1",
					protocol: "openai-completions",
					modelMappings: {
						"alias-a": { provider: "openai", id: "gpt-a" },
						"alias-b": { provider: "anthropic", id: "claude-b" },
					},
					protocolOverrides: {
						"alias-a": "openai-responses",
						"alias-b": "anthropic-messages",
					},
				},
			],
		}),
	);

	const { default: relayModelsExtension } = await import("./index.ts");
	let tool: CapturedTool | undefined;
	const pi = {
		on() {},
		registerProvider() {},
		unregisterProvider() {},
		registerTool(definition: unknown) {
			tool = definition as CapturedTool;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	await relayModelsExtension(pi);
	assert.ok(tool);

	let refreshes = 0;
	const ctx = {
		modelRegistry: {
			getAll() {
				return [];
			},
			getRegisteredProviderIds() {
				return [];
			},
			async refresh() {
				refreshes += 1;
			},
		},
	};

	const unmap = await tool.execute(
		"call-unmap",
		{ action: "unmap", providerId: "relay-clear", remoteModelIds: ["alias-a", "missing"] },
		undefined,
		undefined,
		ctx,
	);
	assert.deepEqual(unmap.details && (unmap.details as { unmapped: string }).unmapped, "relay-clear/alias-a");
	assert.equal(refreshes, 1);
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "relay-providers.json"), "utf8")).providers[0], {
		id: "relay-clear",
		name: "Clear Relay",
		baseUrl: "https://clear.example/v1",
		protocol: "openai-completions",
		modelMappings: {
			"alias-b": { provider: "anthropic", id: "claude-b" },
		},
		protocolOverrides: {
			"alias-a": "openai-responses",
			"alias-b": "anthropic-messages",
		},
	});

	const clear = await tool.execute(
		"call-clear",
		{ action: "clear", providerId: "relay-clear", remoteModelIds: ["alias-a", "alias-b"] },
		undefined,
		undefined,
		ctx,
	);
	assert.deepEqual(clear.details && (clear.details as { cleared: string[] }).cleared, ["relay-clear/alias-a", "relay-clear/alias-b"]);
	assert.equal(refreshes, 2);
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "relay-providers.json"), "utf8")).providers[0], {
		id: "relay-clear",
		name: "Clear Relay",
		baseUrl: "https://clear.example/v1",
		protocol: "openai-completions",
		modelMappings: {
			"alias-b": { provider: "anthropic", id: "claude-b" },
		},
	});

	assert.ok(tool.renderResult);
	initTheme(undefined, false);
	const theme = { fg: (_color: string, text: string) => text };
	const collapsed = tool.renderResult(
		clear,
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "clear" } },
	).render(200);
	assert.equal(collapsed.length, 9);
	assert.match(collapsed[8] ?? "", /more lines.*to expand/u);

	const expanded = tool.renderResult(
		clear,
		{ expanded: true, isPartial: false },
		theme,
		{ args: { action: "clear" } },
	).render(200);
	assert.ok(expanded.length > collapsed.length);
	assert.doesNotMatch(expanded.join("\n"), /more lines.*to expand/u);
	assert.match(expanded.join("\n"), /"protocolOverrides": \{\}/u);
});
