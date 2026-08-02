import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface CapturedTool {
	execute(...args: unknown[]): Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
}

test("remove action unregisters a managed relay and clears runtime state", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-relay-models-agent-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	await writeFile(
		join(agentDir, "relay-providers.json"),
		JSON.stringify({
			version: 1,
			providers: [
				{
					id: "relay-remove",
					name: "Remove Relay",
					baseUrl: "https://remove.example/v1",
					protocol: "openai-completions",
				},
			],
		}),
	);

	const { default: relayModelsExtension } = await import("./index.ts");
	let tool: CapturedTool | undefined;
	const unregistered: string[] = [];
	const pi = {
		on() {},
		registerProvider() {},
		unregisterProvider(providerId: string) {
			unregistered.push(providerId);
		},
		registerTool(definition: unknown) {
			tool = definition as CapturedTool;
		},
		registerCommand() {},
	} as unknown as ExtensionAPI;
	await relayModelsExtension(pi);
	assert.ok(tool);

	const loggedOut: string[] = [];
	const deletedCaches: string[] = [];
	let refreshes = 0;
	const ctx = {
		modelRegistry: {
			runtime: {
				async logout(providerId: string) {
					loggedOut.push(providerId);
				},
				models: {
					modelsStore: {
						async delete(providerId: string) {
							deletedCaches.push(providerId);
						},
					},
				},
			},
			async refresh() {
				refreshes += 1;
			},
		},
	};
	const result = await tool.execute("call-1", { action: "remove", providerId: "relay-remove" }, undefined, undefined, ctx);

	assert.deepEqual(unregistered, ["relay-remove"]);
	assert.deepEqual(loggedOut, ["relay-remove"]);
	assert.deepEqual(deletedCaches, ["relay-remove"]);
	assert.equal(refreshes, 1);
	assert.deepEqual(JSON.parse(await readFile(join(agentDir, "relay-providers.json"), "utf8")), {
		version: 1,
		providers: [],
	});
	assert.deepEqual(result.details, {
		removed: "relay-remove",
		displayName: "Remove Relay",
		credentialCleanup: "runtime",
		modelCacheCleanup: "runtime",
	});
});
