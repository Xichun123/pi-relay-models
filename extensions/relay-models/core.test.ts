import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	collectRelayModelMappings,
	collectRemoteModelIds,
	fetchModelIds,
	getModelsEndpointCandidates,
	materializeRelayModels,
	normalizeBaseUrl,
	normalizeBaseUrlForProtocol,
	parseModelIds,
	spoofHeadersForModel,
	suggestOfficialCandidates,
	suggestProviderIdentity,
	type RelayConfig,
	updateExcludedModelIds,
} from "./core.ts";
import { SPOOF_HEADER_PROFILES } from "./header-profiles.ts";

function model(overrides: Partial<Model<Api>> & Pick<Model<Api>, "id" | "provider" | "api">): Model<Api> {
	return {
		name: overrides.id,
		baseUrl: "https://official.example/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
		...overrides,
	};
}

const relay: RelayConfig = {
	id: "my-relay",
	name: "My Relay",
	baseUrl: "https://relay.example/v1",
	protocol: "openai-completions",
};

test("normalizes URLs and builds model endpoint candidates", () => {
	assert.equal(normalizeBaseUrl(" https://relay.example/v1/ "), "https://relay.example/v1");
	assert.deepEqual(getModelsEndpointCandidates("https://relay.example/v1"), ["https://relay.example/v1/models"]);
	assert.deepEqual(getModelsEndpointCandidates("https://relay.example"), [
		"https://relay.example/models",
		"https://relay.example/v1/models",
	]);
	assert.equal(
		normalizeBaseUrlForProtocol("https://relay.example/anthropic/v1", "anthropic-messages"),
		"https://relay.example/anthropic",
	);
	assert.equal(
		normalizeBaseUrlForProtocol("https://relay.example/v1", "openai-completions"),
		"https://relay.example/v1",
	);
	assert.throws(() => normalizeBaseUrl("file:///tmp/models"));
});

test("derives unique provider identity from the relay hostname", () => {
	assert.deepEqual(suggestProviderIdentity("https://api.any-router.com/v1", new Set()), {
		id: "relay-any-router",
		name: "Any Router Relay",
	});
	assert.equal(
		suggestProviderIdentity("https://api.any-router.com/v1", new Set(["relay-any-router"])).id,
		"relay-any-router-2",
	);
});

test("routes fixed Claude/Codex spoof headers by model API", () => {
	assert.equal(
		spoofHeadersForModel(
			model({ id: "claude-x", provider: "relay", api: "anthropic-messages" }),
			SPOOF_HEADER_PROFILES,
		)?.["user-agent"],
		SPOOF_HEADER_PROFILES.claude["user-agent"],
	);
	assert.equal(
		spoofHeadersForModel(
			model({ id: "claude-1m", provider: "relay", api: "anthropic-messages", contextWindow: 1_000_000 }),
			SPOOF_HEADER_PROFILES,
		)?.["anthropic-beta"],
		SPOOF_HEADER_PROFILES.claudeLongContext["anthropic-beta"],
	);
	assert.equal(
		spoofHeadersForModel(
			model({ id: "claude-sub-1m", provider: "relay", api: "anthropic-messages", contextWindow: 999_999 }),
			SPOOF_HEADER_PROFILES,
		)?.["anthropic-beta"],
		SPOOF_HEADER_PROFILES.claude["anthropic-beta"],
	);
	assert.equal(
		spoofHeadersForModel(model({ id: "gpt-x", provider: "relay", api: "openai-responses" }), SPOOF_HEADER_PROFILES)?.[
			"user-agent"
		],
		SPOOF_HEADER_PROFILES.codex["user-agent"],
	);
	assert.equal(
		spoofHeadersForModel(
			model({ id: "chat-x", provider: "relay", api: "openai-completions" }),
			SPOOF_HEADER_PROFILES,
		)?.["user-agent"],
		SPOOF_HEADER_PROFILES.claude["user-agent"],
	);
	assert.equal("authorization" in SPOOF_HEADER_PROFILES.claude, false);
	assert.equal("cookie" in SPOOF_HEADER_PROFILES.codex, false);
});

test("parses common model-list response shapes and deduplicates IDs", () => {
	assert.deepEqual(parseModelIds({ data: [{ id: "gpt-x" }, { id: "gpt-x" }, { id: "claude-y" }] }), [
		"gpt-x",
		"claude-y",
	]);
	assert.deepEqual(parseModelIds({ models: ["one", { id: "two" }] }), ["one", "two"]);
	assert.throws(() => parseModelIds({ object: "list" }));
});

test("fetches OpenAI-compatible model IDs with endpoint fallback and bearer auth", async () => {
	const paths: string[] = [];
	const server = createServer((request, response) => {
		paths.push(request.url ?? "");
		if (request.url === "/models") {
			response.writeHead(404).end("not found");
			return;
		}
		assert.equal(request.headers.authorization, "Bearer secret-key");
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify({ data: [{ id: "gpt-x" }] }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected TCP server address");
		const ids = await fetchModelIds({ ...relay, baseUrl: `http://127.0.0.1:${address.port}` }, "secret-key");
		assert.deepEqual(ids, ["gpt-x"]);
		assert.deepEqual(paths, ["/models", "/v1/models"]);
	} finally {
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
});

test("suggests close official model IDs for AI/user review", () => {
	const catalog = [
		model({ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet 4.6" }),
		model({ id: "gpt-5.4", provider: "openai", api: "openai-responses", name: "GPT-5.4" }),
	];
	const candidates = suggestOfficialCandidates("claude-sonnet-4.6-latest", catalog);
	assert.equal(candidates[0]?.provider, "anthropic");
	assert.equal(candidates[0]?.id, "claude-sonnet-4-6");
});

test("copies official metadata while replacing routing fields", () => {
	const official = model({
		id: "gpt-x",
		provider: "openai",
		api: "openai-responses",
		name: "GPT X",
		thinkingLevelMap: { high: "high" },
	});
	const result = materializeRelayModels(relay, ["gpt-x"], [official]);
	assert.equal(result.matched, 1);
	assert.deepEqual(result.unmatched, []);
	assert.deepEqual(result.models[0], {
		...official,
		provider: "my-relay",
		api: "openai-responses",
		baseUrl: "https://relay.example/v1",
	});
});

test("uses a user-approved mapping while preserving the relay model ID", () => {
	const official = model({ id: "claude-sonnet-4-6", provider: "anthropic", api: "anthropic-messages", name: "Claude Sonnet 4.6" });
	const result = materializeRelayModels(
		{
			...relay,
			modelMappings: { "claude-sonnet-latest": { provider: "anthropic", id: "claude-sonnet-4-6" } },
		},
		["claude-sonnet-latest"],
		[official],
	);
	assert.equal(result.matched, 1);
	assert.equal(result.models[0]?.id, "claude-sonnet-latest");
	assert.equal(result.models[0]?.name, "Claude Sonnet 4.6");
	assert.equal(result.models[0]?.api, "anthropic-messages");
	assert.equal(result.models[0]?.baseUrl, "https://relay.example");
});

test("routes mixed official models through three APIs in one relay provider", () => {
	const catalog = [
		model({ id: "claude-x", provider: "anthropic", api: "anthropic-messages" }),
		model({ id: "gpt-x", provider: "openai", api: "openai-responses" }),
		model({ id: "other-x", provider: "openrouter", api: "openai-completions" }),
	];
	const result = materializeRelayModels(relay, ["claude-x", "gpt-x", "other-x"], catalog);
	assert.deepEqual(result.models.map((entry) => entry.api), [
		"anthropic-messages",
		"openai-responses",
		"openai-completions",
	]);
});

test("applies a user-approved per-model protocol override", () => {
	const official = model({ id: "gpt-x", provider: "openai", api: "openai-responses" });
	const result = materializeRelayModels(
		{ ...relay, protocolOverrides: { "gpt-x": "openai-completions" } },
		["gpt-x"],
		[official],
	);
	assert.equal(result.models[0]?.api, "openai-completions");
});

test("normalizes batch mappings and applies the shared protocol once", () => {
	assert.deepEqual(
		collectRelayModelMappings(
			undefined,
			[
				{ remoteModelId: " first ", officialProvider: " openai ", officialModelId: " gpt-first " },
				{
					remoteModelId: "second",
					officialProvider: "anthropic",
					officialModelId: "claude-second",
					protocol: "anthropic-messages",
				},
			],
			"openai-responses",
		),
		[
			{
				remoteModelId: "first",
				officialProvider: "openai",
				officialModelId: "gpt-first",
				protocol: "openai-responses",
			},
			{
				remoteModelId: "second",
				officialProvider: "anthropic",
				officialModelId: "claude-second",
				protocol: "anthropic-messages",
			},
		],
	);
});

test("rejects incomplete or duplicate batch mappings before mutation", () => {
	assert.throws(
		() => collectRelayModelMappings({ remoteModelId: "only-id" }, undefined),
		/officialProvider, and officialModelId are required/u,
	);
	assert.throws(
		() =>
			collectRelayModelMappings(undefined, [
				{ remoteModelId: "same", officialProvider: "openai", officialModelId: "gpt-one" },
				{ remoteModelId: " same ", officialProvider: "openai", officialModelId: "gpt-two" },
			]),
		/Duplicate remote model ID: same/u,
	);
	assert.throws(() => collectRelayModelMappings(undefined, undefined), /At least one model mapping is required/u);
});

test("normalizes batch exclusion targets and updates them together", () => {
	const modelIds = collectRemoteModelIds(" first ", ["second", "first", " ", "third"]);
	assert.deepEqual(modelIds, ["first", "second", "third"]);
	assert.deepEqual(updateExcludedModelIds(["existing"], modelIds, true), ["existing", "first", "second", "third"]);
	assert.deepEqual(updateExcludedModelIds(["existing", "first", "second", "third"], ["first", "third"], false), [
		"existing",
		"second",
	]);
});

test("persistently excludes configured relay model IDs during materialization", () => {
	const official = model({ id: "gpt-4-32k", provider: "openai", api: "openai-responses" });
	const result = materializeRelayModels(
		{ ...relay, excludedModels: ["gpt-4-32k"] },
		["gpt-4-32k", "keep-me"],
		[official],
	);
	assert.deepEqual(result.models.map((entry) => entry.id), ["keep-me"]);
	assert.deepEqual(result.unmatched, ["keep-me"]);
});

test("prefers direct official provider and supplies safe fallback metadata", () => {
	const gatewayCopy = model({ id: "same-id", provider: "openrouter", api: "openai-completions", name: "Gateway" });
	const direct = model({ id: "same-id", provider: "openai", api: "openai-responses", name: "Direct" });
	const result = materializeRelayModels(relay, ["same-id", "unknown-id"], [gatewayCopy, direct]);
	assert.equal(result.models[0]?.name, "Direct");
	assert.equal(result.models[1]?.name, "unknown-id");
	assert.equal(result.models[1]?.reasoning, false);
	assert.deepEqual(result.unmatched, ["unknown-id"]);
});
