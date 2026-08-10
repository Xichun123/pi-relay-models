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
			getProvider() {
				return undefined;
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
	assert.match(collapsed[8] ?? "", /more lines.*full details/u);

	const expanded = tool.renderResult(
		clear,
		{ expanded: true, isPartial: false },
		theme,
		{ args: { action: "clear" } },
	).render(200);
	assert.ok(expanded.length > collapsed.length);
	assert.doesNotMatch(expanded.join("\n"), /more lines.*full details/u);
	assert.match(expanded.join("\n"), /"protocolOverrides": \{\}/u);

	const matchedModels = Array.from({ length: 6 }, (_, index) => ({
		id: `model-${index + 1}`,
		protocol: "openai-responses",
		metadataSource: `openai/model-${index + 1}`,
	}));
	const statusReport = [
		{
			providerId: "relay-clear",
			displayName: "Clear Relay",
			baseUrl: "https://clear.example/v1",
			fallbackProtocol: "openai-completions",
			modelCount: 6,
			matchedModels,
			unmatchedModels: [],
			protocols: { "openai-completions": 0, "openai-responses": 6, "anthropic-messages": 0 },
			syncedAt: "2026-08-10T00:00:00.000Z",
			mappings: {},
			protocolOverrides: {},
			excludedModels: [],
			headerProfiles: { claude: false, codex: false },
		},
	];
	const statusResult = {
		content: [{ type: "text", text: JSON.stringify(statusReport, null, 2) }],
		details: statusReport,
	};
	const statusPreview = tool.renderResult(
		statusResult,
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "status" } },
	).render(200);
	assert.match(statusPreview.join("\n"), /6 models.*6 matched.*0 unmatched/u);
	for (const model of matchedModels) {
		assert.match(statusPreview.join("\n"), new RegExp(`${model.id}.*${model.metadataSource}`, "u"));
	}
	assert.doesNotMatch(statusPreview.join("\n"), /more models.*full details/u);

	const overflowModels = Array.from({ length: 13 }, (_, index) => ({
		id: `overflow-${index + 1}`,
		protocol: "openai-responses",
		metadataSource: `openai/overflow-${index + 1}`,
	}));
	const overflowReport = [{ ...statusReport[0], modelCount: 13, matchedModels: overflowModels }];
	const overflowPreview = tool.renderResult(
		{
			content: [{ type: "text", text: JSON.stringify(overflowReport, null, 2) }],
			details: overflowReport,
		},
		{ expanded: false, isPartial: false },
		theme,
		{ args: { action: "status" } },
	).render(200);
	assert.match(overflowPreview.join("\n"), /overflow-12/u);
	assert.doesNotMatch(overflowPreview.join("\n"), /overflow-13/u);
	assert.match(overflowPreview.join("\n"), /1 more models.*full details/u);

	const oversized = await tool.execute(
		"call-oversized",
		{
			action: "add",
			providerId: "relay-oversized",
			displayName: "x".repeat(60_000),
			baseUrl: "https://oversized.example/v1",
			protocol: "openai-completions",
		},
		undefined,
		undefined,
		ctx,
	);
	const oversizedText = oversized.content[0]?.text ?? "";
	assert.ok(Buffer.byteLength(oversizedText, "utf8") < 52 * 1024);
	assert.match(oversizedText, /Output truncated: showing/u);
	const outputPath = oversizedText.match(/Full output saved to: (.+)\]/u)?.[1];
	assert.ok(outputPath);
	assert.match(await readFile(outputPath, "utf8"), /"providerId"|"id": "relay-oversized"/u);
});
