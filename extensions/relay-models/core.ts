import type { Api, Model } from "@earendil-works/pi-ai";

export type RelayProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

export interface OfficialModelRef {
	provider: string;
	id: string;
}

export interface RelayConfig {
	id: string;
	name: string;
	baseUrl: string;
	/** Fallback protocol for unmatched models and /models authentication. */
	protocol: RelayProtocol;
	modelMappings?: Record<string, OfficialModelRef>;
	protocolOverrides?: Record<string, RelayProtocol>;
	excludedModels?: string[];
}

export interface ModelCandidate extends OfficialModelRef {
	name: string;
	score: number;
}

export interface RelayModelResponse {
	models: Model<Api>[];
	matched: number;
	unmatched: string[];
}

export interface SpoofHeaderProfiles {
	claude?: Record<string, string>;
	claudeLongContext?: Record<string, string>;
	codex?: Record<string, string>;
}

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function spoofHeadersForModel(model: Model<Api>, profiles: SpoofHeaderProfiles): Record<string, string> | undefined {
	if (model.api === "openai-responses") return profiles.codex;
	if (model.api === "anthropic-messages") {
		return model.contextWindow >= 1_000_000
			? (profiles.claudeLongContext ?? profiles.claude)
			: (profiles.claude ?? profiles.claudeLongContext);
	}
	if (model.api === "openai-completions") return profiles.claude ?? profiles.claudeLongContext;
	return undefined;
}

export function normalizeBaseUrl(raw: string): string {
	const value = raw.trim();
	if (!value) throw new Error("Base URL cannot be empty");

	const parsed = new URL(value);
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("Base URL must use http:// or https://");
	}
	if (parsed.username || parsed.password) {
		throw new Error("Do not include credentials in the Base URL");
	}

	return parsed.toString().replace(/\/$/u, "");
}

export function normalizeBaseUrlForProtocol(raw: string, protocol: RelayProtocol): string {
	const normalized = normalizeBaseUrl(raw);
	if (protocol !== "anthropic-messages") return normalized;

	const parsed = new URL(normalized);
	if (parsed.pathname.endsWith("/v1")) {
		parsed.pathname = parsed.pathname.slice(0, -3) || "/";
		return parsed.toString().replace(/\/$/u, "");
	}
	return normalized;
}

export function validateProviderId(raw: string): string {
	const id = raw.trim().toLowerCase();
	if (!/^[a-z0-9][a-z0-9._-]*$/u.test(id)) {
		throw new Error("Provider ID may contain lowercase letters, numbers, dots, underscores, and hyphens");
	}
	return id;
}

export function collectRemoteModelIds(remoteModelId?: string, remoteModelIds?: readonly string[]): string[] {
	return [remoteModelId, ...(remoteModelIds ?? [])]
		.filter((modelId): modelId is string => typeof modelId === "string")
		.map((modelId) => modelId.trim())
		.filter((modelId, index, values) => modelId.length > 0 && values.indexOf(modelId) === index);
}

export function updateExcludedModelIds(
	excludedModels: readonly string[] | undefined,
	modelIds: readonly string[],
	excluded: boolean,
): string[] {
	const values = new Set(excludedModels ?? []);
	for (const modelId of modelIds) {
		if (excluded) values.add(modelId);
		else values.delete(modelId);
	}
	return [...values].sort();
}

export function suggestProviderIdentity(rawBaseUrl: string, existingIds: ReadonlySet<string>): { id: string; name: string } {
	const hostname = new URL(normalizeBaseUrl(rawBaseUrl)).hostname.toLowerCase();
	const labels = hostname.split(".").filter(Boolean);
	const generic = new Set(["api", "www", "gateway", "proxy", "openai", "anthropic", "ai", "v1", "com", "net", "org", "io", "cn"]);
	const brand = labels.find((label) => !generic.has(label)) ?? labels[0] ?? "relay";
	const baseId = validateProviderId(`relay-${brand.replace(/[^a-z0-9._-]+/gu, "-")}`);
	let id = baseId;
	let suffix = 2;
	while (existingIds.has(id)) {
		id = `${baseId}-${suffix}`;
		suffix += 1;
	}
	const readable = brand
		.split(/[-_]+/u)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
	return { id, name: `${readable || "Model"} Relay` };
}

export function getModelsEndpointCandidates(baseUrl: string): string[] {
	const normalized = normalizeBaseUrl(baseUrl);
	const parsed = new URL(normalized);
	const path = parsed.pathname.replace(/\/$/u, "");
	const candidates = [`${normalized}/models`];
	if (!path.endsWith("/v1")) candidates.push(`${normalized}/v1/models`);
	return [...new Set(candidates)];
}

export function parseModelIds(payload: unknown): string[] {
	let entries: unknown;
	if (Array.isArray(payload)) {
		entries = payload;
	} else if (payload && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		entries = Array.isArray(record.data) ? record.data : record.models;
	}

	if (!Array.isArray(entries)) throw new Error("The /models response does not contain a model array");

	const ids = entries
		.map((entry) => {
			if (typeof entry === "string") return entry.trim();
			if (entry && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string") {
				return (entry as { id: string }).id.trim();
			}
			return "";
		})
		.filter(Boolean);

	return [...new Set(ids)];
}

function authHeaders(protocol: RelayProtocol, apiKey: string): Record<string, string> {
	if (protocol === "anthropic-messages") {
		return {
			accept: "application/json",
			"anthropic-version": "2023-06-01",
			"x-api-key": apiKey,
		};
	}
	return { accept: "application/json", authorization: `Bearer ${apiKey}` };
}

async function responseError(response: Response): Promise<string> {
	const text = (await response.text()).replace(/\s+/gu, " ").trim();
	return text ? `${response.status} ${text.slice(0, 300)}` : `${response.status} ${response.statusText}`;
}

export async function fetchModelIds(config: RelayConfig, apiKey: string, signal?: AbortSignal): Promise<string[]> {
	const candidates = getModelsEndpointCandidates(config.baseUrl);
	let lastError = "";

	for (let index = 0; index < candidates.length; index += 1) {
		const endpoint = candidates[index]!;
		const response = await fetch(endpoint, { headers: authHeaders(config.protocol, apiKey), signal });
		if (response.ok) return parseModelIds(await response.json());

		lastError = `${endpoint}: ${await responseError(response)}`;
		if (response.status !== 404 && response.status !== 405) break;
	}

	throw new Error(`Unable to fetch relay model list (${lastError})`);
}

function sourceRank(model: Model<Api>): number {
	if (model.provider === "anthropic" || model.provider === "openai") return 0;
	if (model.provider === "openai-codex") return 1;
	if (model.api === "anthropic-messages" || model.api === "openai-responses" || model.api === "openai-completions") {
		return 2;
	}
	if (model.api.startsWith("openai-")) return 3;
	return 10;
}

function buildCatalogIndex(catalog: readonly Model<Api>[]): Map<string, Model<Api>> {
	const byId = new Map<string, Model<Api>>();
	for (const candidate of catalog) {
		const current = byId.get(candidate.id);
		if (!current || sourceRank(candidate) < sourceRank(current)) {
			byId.set(candidate.id, candidate);
		}
	}
	return byId;
}

function normalizeModelName(value: string): string {
	return value
		.toLowerCase()
		.replace(/^.*\//u, "")
		.replace(/(?:^|[-_.])20\d{6}$/u, "")
		.replace(/[^a-z0-9]+/gu, "");
}

function editDistance(left: string, right: string): number {
	const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
		const current = [leftIndex];
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
			current[rightIndex] = Math.min(
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
		}
		for (let index = 0; index < current.length; index += 1) previous[index] = current[index]!;
	}
	return previous[right.length] ?? Math.max(left.length, right.length);
}

export function suggestOfficialCandidates(
	remoteModelId: string,
	catalog: readonly Model<Api>[],
	limit = 3,
): ModelCandidate[] {
	const needle = normalizeModelName(remoteModelId);
	if (!needle) return [];
	const deduplicated = new Map<string, ModelCandidate>();

	for (const model of catalog) {
		const candidate = normalizeModelName(model.id);
		if (!candidate) continue;
		const maxLength = Math.max(needle.length, candidate.length);
		const similarity = maxLength === 0 ? 1 : 1 - editDistance(needle, candidate) / maxLength;
		const containment = needle.includes(candidate) || candidate.includes(needle) ? 0.25 : 0;
		const score = Math.round(Math.min(1, similarity + containment) * 100);
		const key = `${model.provider}/${model.id}`;
		const value = { provider: model.provider, id: model.id, name: model.name, score };
		const existing = deduplicated.get(key);
		if (!existing || value.score > existing.score) deduplicated.set(key, value);
	}

	return [...deduplicated.values()]
		.filter((candidate) => candidate.score >= 35)
		.sort((a, b) => b.score - a.score || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id))
		.slice(0, limit);
}

export function inferRelayProtocol(source: Model<Api> | undefined, fallback: RelayProtocol): RelayProtocol {
	if (!source) return fallback;
	if (source.provider === "anthropic" || source.api === "anthropic-messages") return "anthropic-messages";
	if (
		source.provider === "openai" ||
		source.provider === "openai-codex" ||
		source.api === "openai-responses" ||
		source.api === "openai-codex-responses" ||
		source.api === "azure-openai-responses"
	) {
		return "openai-responses";
	}
	return "openai-completions";
}

function copyOfficialModel(config: RelayConfig, id: string, source: Model<Api>): Model<Api> {
	const copied = structuredClone(source) as Model<Api>;
	delete copied.headers;
	const protocol = config.protocolOverrides?.[id] ?? inferRelayProtocol(source, config.protocol);
	return {
		...copied,
		id,
		provider: config.id,
		api: protocol,
		baseUrl: normalizeBaseUrlForProtocol(config.baseUrl, protocol),
	};
}

function fallbackModel(config: RelayConfig, id: string): Model<Api> {
	const protocol = config.protocolOverrides?.[id] ?? config.protocol;
	return {
		id,
		name: id,
		provider: config.id,
		api: protocol,
		baseUrl: normalizeBaseUrlForProtocol(config.baseUrl, protocol),
		reasoning: false,
		input: ["text"],
		cost: { ...DEFAULT_COST },
		contextWindow: 128_000,
		maxTokens: 16_384,
	} as Model<Api>;
}

export function materializeRelayModels(
	config: RelayConfig,
	modelIds: readonly string[],
	catalog: readonly Model<Api>[],
): RelayModelResponse {
	const index = buildCatalogIndex(catalog);
	const byReference = new Map(catalog.map((model) => [`${model.provider}/${model.id}`, model]));
	const models: Model<Api>[] = [];
	const unmatched: string[] = [];
	let matched = 0;

	const excluded = new Set(config.excludedModels ?? []);
	for (const id of [...new Set(modelIds.map((value) => value.trim()).filter(Boolean))].filter((value) => !excluded.has(value))) {
		const mapping = config.modelMappings?.[id];
		const source = mapping ? byReference.get(`${mapping.provider}/${mapping.id}`) : index.get(id);
		if (source) {
			models.push(copyOfficialModel(config, id, source));
			matched += 1;
		} else {
			models.push(fallbackModel(config, id));
			unmatched.push(id);
		}
	}

	return { models, matched, unmatched };
}
