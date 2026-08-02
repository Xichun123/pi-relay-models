import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	anthropicMessagesApi,
	createProvider,
	getModels,
	getProviders,
	type Api,
	type ApiKeyCredential,
	type Model,
	openAICompletionsApi,
	openAIResponsesApi,
	type Provider,
	StringEnum,
} from "@earendil-works/pi-ai/compat";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	collectRelayModelMappings,
	collectRemoteModelIds,
	fetchModelIds,
	materializeRelayModels,
	normalizeBaseUrl,
	spoofHeadersForModel,
	suggestOfficialCandidates,
	suggestProviderIdentity,
	type RelayConfig,
	type RelayModelResponse,
	type RelayProtocol,
	updateExcludedModelIds,
	validateProviderId,
} from "./core.ts";
import { SPOOF_HEADER_PROFILES } from "./header-profiles.ts";
import { deleteJsonRecordKey } from "./state.ts";

interface ConfigFile {
	version: 1;
	providers: RelayConfig[];
}

interface SyncStatus {
	modelCount: number;
	matched: number;
	unmatched: string[];
	protocols: Record<RelayProtocol, number>;
	updatedAt: number;
}

const AGENT_DIR = getAgentDir();
const CONFIG_PATH = join(AGENT_DIR, "relay-providers.json");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const MODELS_STORE_PATH = join(AGENT_DIR, "models-store.json");
const builtinProviderNames = getProviders();
const builtinProviderIds: ReadonlySet<string> = new Set(builtinProviderNames);
let officialCatalog: Model<Api>[] = builtinProviderNames.flatMap((provider) => getModels(provider) as Model<Api>[]);
let configFile: ConfigFile = { version: 1, providers: [] };
const syncStatuses = new Map<string, SyncStatus>();

function isRelayProtocol(value: unknown): value is RelayProtocol {
	return value === "openai-completions" || value === "openai-responses" || value === "anthropic-messages";
}

function parseConfigFile(value: unknown): ConfigFile {
	if (!value || typeof value !== "object") throw new Error("Configuration must be a JSON object");
	const input = value as { version?: unknown; providers?: unknown };
	if (input.version !== 1 || !Array.isArray(input.providers)) throw new Error("Unsupported relay provider config version");

	const providers = input.providers.map((entry) => {
		if (!entry || typeof entry !== "object") throw new Error("Invalid relay provider entry");
		const item = entry as Partial<RelayConfig>;
		if (typeof item.id !== "string" || typeof item.name !== "string" || typeof item.baseUrl !== "string") {
			throw new Error("Relay provider entries require id, name, and baseUrl");
		}
		if (!isRelayProtocol(item.protocol)) throw new Error(`Invalid protocol for relay provider ${item.id}`);
		const modelMappings: RelayConfig["modelMappings"] = {};
		if (item.modelMappings && typeof item.modelMappings === "object") {
			for (const [remoteId, reference] of Object.entries(item.modelMappings)) {
				if (
					reference &&
					typeof reference === "object" &&
					typeof reference.provider === "string" &&
					typeof reference.id === "string"
				) {
					modelMappings[remoteId] = { provider: reference.provider, id: reference.id };
				}
			}
		}
		const protocolOverrides: RelayConfig["protocolOverrides"] = {};
		if (item.protocolOverrides && typeof item.protocolOverrides === "object") {
			for (const [remoteId, protocol] of Object.entries(item.protocolOverrides)) {
				if (isRelayProtocol(protocol)) protocolOverrides[remoteId] = protocol;
			}
		}
		const excludedModels = Array.isArray(item.excludedModels)
			? [...new Set(item.excludedModels.filter((modelId): modelId is string => typeof modelId === "string" && modelId.trim().length > 0))]
			: [];
		return {
			id: validateProviderId(item.id),
			name: item.name.trim() || item.id,
			baseUrl: normalizeBaseUrl(item.baseUrl),
			protocol: item.protocol,
			...(Object.keys(modelMappings).length > 0 ? { modelMappings } : {}),
			...(Object.keys(protocolOverrides).length > 0 ? { protocolOverrides } : {}),
			...(excludedModels.length > 0 ? { excludedModels } : {}),
		};
	});

	return { version: 1, providers };
}

async function loadConfig(): Promise<ConfigFile> {
	try {
		return parseConfigFile(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, providers: [] };
		throw new Error(`Cannot load ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveConfig(next: ConfigFile): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	const tempPath = `${CONFIG_PATH}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	await rename(tempPath, CONFIG_PATH);
	await chmod(CONFIG_PATH, 0o600);
}

function makeProvider(config: RelayConfig): Provider<Api> {
	return createProvider<Api>({
		id: config.id,
		name: config.name,
		baseUrl: config.baseUrl,
		auth: {
			apiKey: {
				name: `${config.name} API key`,
				async login(interaction): Promise<ApiKeyCredential> {
					const key = await interaction.prompt({
						type: "secret",
						message: `Enter the API key for ${config.name}`,
					});
					if (!key.trim()) throw new Error("API key cannot be empty");
					return { type: "api_key", key: key.trim() };
				},
				async check({ credential }) {
					return credential?.key ? { type: "api_key" as const, source: "stored API key" } : undefined;
				},
				async resolve({ credential }) {
					return credential?.key
						? { auth: { apiKey: credential.key }, source: "stored API key" }
						: undefined;
				},
			},
		},
		models: [],
		async fetchModels({ credential, signal }) {
			const key = credential?.type === "api_key" ? credential.key : undefined;
			if (!key) throw new Error(`No API key for ${config.id}; run /login ${config.id}`);

			const ids = await fetchModelIds(config, key, signal);
			const materialized: RelayModelResponse = materializeRelayModels(config, ids, officialCatalog);
			const result: RelayModelResponse = {
				...materialized,
				models: materialized.models.map((model) => {
					const headers = spoofHeadersForModel(model, SPOOF_HEADER_PROFILES);
					return headers ? { ...model, headers: { ...(model.headers ?? {}), ...headers } } : model;
				}),
			};
			const protocols: Record<RelayProtocol, number> = {
				"openai-completions": 0,
				"openai-responses": 0,
				"anthropic-messages": 0,
			};
			for (const model of result.models) {
				if (isRelayProtocol(model.api)) protocols[model.api] += 1;
			}
			syncStatuses.set(config.id, {
				modelCount: result.models.length,
				matched: result.matched,
				unmatched: result.unmatched,
				protocols,
				updatedAt: Date.now(),
			});
			return result.models;
		},
		api: {
			"openai-completions": openAICompletionsApi(),
			"openai-responses": openAIResponsesApi(),
			"anthropic-messages": anthropicMessagesApi(),
		},
	});
}

function registerConfig(pi: ExtensionAPI, config: RelayConfig): void {
	pi.registerProvider(makeProvider(config));
}

async function saveAndRegister(pi: ExtensionAPI, config: RelayConfig): Promise<void> {
	const replacing = configFile.providers.some((provider) => provider.id === config.id);
	const providers = configFile.providers.filter((provider) => provider.id !== config.id);
	configFile = { version: 1, providers: [...providers, config].sort((a, b) => a.id.localeCompare(b.id)) };
	await saveConfig(configFile);
	if (replacing) pi.unregisterProvider(config.id);
	registerConfig(pi, config);
}

interface InternalModelRuntime {
	logout?(providerId: string): Promise<void>;
	models?: {
		modelsStore?: {
			delete(providerId: string): Promise<void>;
		};
	};
}

// Pi 0.82.1 does not expose credential/cache deletion on ModelRegistry. Prefer
// the live runtime capability so its in-memory state stays coherent, then fall
// back to the same persisted files when that internal capability is unavailable.
function getInternalModelRuntime(
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): InternalModelRuntime | undefined {
	return (ctx.modelRegistry as unknown as { runtime?: InternalModelRuntime }).runtime;
}

async function cleanupRelayProviderState(
	providerId: string,
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
): Promise<{ credential: "runtime" | "file"; modelCache: "runtime" | "file" }> {
	const runtime = getInternalModelRuntime(ctx);
	let credential: "runtime" | "file";
	if (runtime?.logout) {
		await runtime.logout(providerId);
		credential = "runtime";
	} else {
		await deleteJsonRecordKey(AUTH_PATH, providerId);
		credential = "file";
	}

	let modelCache: "runtime" | "file";
	if (runtime?.models?.modelsStore) {
		await runtime.models.modelsStore.delete(providerId);
		modelCache = "runtime";
	} else {
		await deleteJsonRecordKey(MODELS_STORE_PATH, providerId);
		modelCache = "file";
	}
	return { credential, modelCache };
}

async function removeRelayForAi(
	pi: ExtensionAPI,
	params: { providerId?: string },
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	if (!params.providerId) throw new Error("providerId is required for action=remove");
	const providerId = validateProviderId(params.providerId);
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);

	const next: ConfigFile = {
		version: 1,
		providers: configFile.providers.filter((provider) => provider.id !== providerId),
	};
	await saveConfig(next);
	configFile = next;
	pi.unregisterProvider(providerId);
	syncStatuses.delete(providerId);
	const cleanup = await cleanupRelayProviderState(providerId, ctx);
	await ctx.modelRegistry.refresh();
	return {
		removed: providerId,
		displayName: current.name,
		credentialCleanup: cleanup.credential,
		modelCacheCleanup: cleanup.modelCache,
	};
}

function refreshOfficialCatalog(ctx: Pick<ExtensionCommandContext, "modelRegistry">): void {
	const live = ctx.modelRegistry.getAll().filter((model) => builtinProviderIds.has(model.provider));
	if (live.length > 0) officialCatalog = live;
}

function protocolDescription(protocol: RelayProtocol): string {
	switch (protocol) {
		case "anthropic-messages":
			return "Anthropic Messages";
		case "openai-responses":
			return "OpenAI Responses";
		default:
			return "OpenAI Chat Completions";
	}
}

function relayReports(providerId?: string) {
	return configFile.providers
		.filter((config) => !providerId || config.id === providerId)
		.map((config) => {
			const status = syncStatuses.get(config.id);
			const unmatched = status?.unmatched ?? [];
			return {
				providerId: config.id,
				displayName: config.name,
				baseUrl: config.baseUrl,
				protocol: config.protocol,
				modelCount: status?.modelCount,
				matched: status?.matched,
				protocols: status?.protocols,
				unmatched,
				candidates: Object.fromEntries(
					unmatched.map((modelId) => [modelId, suggestOfficialCandidates(modelId, officialCatalog)]),
				),
				mappings: config.modelMappings ?? {},
				protocolOverrides: config.protocolOverrides ?? {},
				excludedModels: config.excludedModels ?? [],
				headerProfiles: {
					claude: Boolean(SPOOF_HEADER_PROFILES.claude || SPOOF_HEADER_PROFILES.claudeLongContext),
					codex: Boolean(SPOOF_HEADER_PROFILES.codex),
				},
			};
		});
}

async function addRelayForAi(
	pi: ExtensionAPI,
	params: {
		baseUrl?: string;
		protocol?: RelayProtocol;
		providerId?: string;
		displayName?: string;
	},
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	if (!params.baseUrl) throw new Error("baseUrl is required for action=add");
	if (params.protocol && !isRelayProtocol(params.protocol)) throw new Error("Unsupported fallback protocol for action=add");

	const existingIds = new Set(ctx.modelRegistry.getAll().map((model) => model.provider));
	for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) existingIds.add(providerId);
	for (const config of configFile.providers) existingIds.add(config.id);
	const suggested = suggestProviderIdentity(params.baseUrl, existingIds);
	const id = params.providerId ? validateProviderId(params.providerId) : suggested.id;
	const managed = configFile.providers.find((provider) => provider.id === id);
	if (ctx.modelRegistry.getProvider(id) && !managed) throw new Error(`Provider '${id}' already exists and is not managed by relay-models`);

	const config: RelayConfig = {
		id,
		name: params.displayName?.trim() || managed?.name || suggested.name,
		baseUrl: normalizeBaseUrl(params.baseUrl),
		protocol: params.protocol ?? managed?.protocol ?? "openai-completions",
		...(managed?.modelMappings ? { modelMappings: managed.modelMappings } : {}),
		...(managed?.protocolOverrides ? { protocolOverrides: managed.protocolOverrides } : {}),
		...(managed?.excludedModels ? { excludedModels: managed.excludedModels } : {}),
	};
	await saveAndRegister(pi, config);
	return {
		provider: config,
		nextStep: `/login ${id}`,
		note: "The API key must be entered through pi /login and is never exposed to the AI.",
	};
}

async function mapRelayModels(
	pi: ExtensionAPI,
	params: {
		providerId?: string;
		remoteModelId?: string;
		officialProvider?: string;
		officialModelId?: string;
		protocol?: RelayProtocol;
		mappings?: Array<{
			remoteModelId: string;
			officialProvider: string;
			officialModelId: string;
			protocol?: RelayProtocol;
		}>;
	},
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	const { providerId } = params;
	if (!providerId) throw new Error("providerId is required for action=map");
	const mappings = collectRelayModelMappings(
		{
			remoteModelId: params.remoteModelId,
			officialProvider: params.officialProvider,
			officialModelId: params.officialModelId,
			protocol: params.protocol,
		},
		params.mappings,
		params.protocol,
	);
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);

	refreshOfficialCatalog(ctx);
	const officialReferences = new Set(officialCatalog.map((model) => `${model.provider}/${model.id}`));
	const missing = mappings
		.map((mapping) => `${mapping.officialProvider}/${mapping.officialModelId}`)
		.filter((reference) => !officialReferences.has(reference));
	if (missing.length === 1) throw new Error(`Official model not found: ${missing[0]}`);
	if (missing.length > 1) throw new Error(`Official models not found: ${missing.join(", ")}`);

	const modelMappings = { ...(current.modelMappings ?? {}) };
	const protocolOverrides = { ...(current.protocolOverrides ?? {}) };
	for (const mapping of mappings) {
		modelMappings[mapping.remoteModelId] = {
			provider: mapping.officialProvider,
			id: mapping.officialModelId,
		};
		if (mapping.protocol) protocolOverrides[mapping.remoteModelId] = mapping.protocol;
	}
	const config: RelayConfig = {
		...current,
		modelMappings,
		...(Object.keys(protocolOverrides).length > 0 ? { protocolOverrides } : {}),
	};
	await saveAndRegister(pi, config);
	await ctx.modelRegistry.refresh();

	const mapped = mappings.map((mapping) => ({
		model: `${providerId}/${mapping.remoteModelId}`,
		metadataSource: `${mapping.officialProvider}/${mapping.officialModelId}`,
		protocolOverride: mapping.protocol,
	}));
	const report = relayReports(providerId)[0];
	if (!params.mappings && mapped.length === 1) {
		const [entry] = mapped;
		return {
			mapped: entry!.model,
			metadataSource: entry!.metadataSource,
			protocolOverride: entry!.protocolOverride,
			report,
		};
	}
	return { mapped, count: mapped.length, report };
}

async function setRelayModelProtocol(
	pi: ExtensionAPI,
	params: { providerId?: string; remoteModelId?: string; protocol?: RelayProtocol },
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	const { providerId, remoteModelId, protocol } = params;
	if (!providerId || !remoteModelId || !protocol || !isRelayProtocol(protocol)) {
		throw new Error("providerId, remoteModelId, and protocol are required for action=protocol");
	}
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);
	const config: RelayConfig = {
		...current,
		protocolOverrides: { ...(current.protocolOverrides ?? {}), [remoteModelId]: protocol },
	};
	await saveAndRegister(pi, config);
	await ctx.modelRegistry.refresh();
	return { model: `${providerId}/${remoteModelId}`, protocol, report: relayReports(providerId)[0] };
}

async function setRelayModelExclusion(
	pi: ExtensionAPI,
	params: { providerId?: string; remoteModelId?: string; remoteModelIds?: string[] },
	excluded: boolean,
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	const { providerId } = params;
	const modelIds = collectRemoteModelIds(params.remoteModelId, params.remoteModelIds);
	if (!providerId || modelIds.length === 0) {
		throw new Error("providerId and at least one remoteModelId or remoteModelIds entry are required");
	}
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);
	const values = updateExcludedModelIds(current.excludedModels, modelIds, excluded);
	const config: RelayConfig = {
		...current,
		...(values.length > 0 ? { excludedModels: values } : { excludedModels: undefined }),
	};
	await saveAndRegister(pi, config);
	await ctx.modelRegistry.refresh();
	const targets = modelIds.map((modelId) => `${providerId}/${modelId}`);
	return {
		...(targets.length === 1 ? { model: targets[0] } : { models: targets }),
		excluded,
		report: relayReports(providerId)[0],
	};
}

async function addRelay(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/relay-add requires interactive or RPC UI mode", "error");
		return;
	}

	const rawId = await ctx.ui.input("Relay provider ID", "my-relay");
	if (rawId === undefined) return;

	let id: string;
	try {
		id = validateProviderId(rawId);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}

	const managed = configFile.providers.find((provider) => provider.id === id);
	if (ctx.modelRegistry.getProvider(id) && !managed) {
		ctx.ui.notify(`Provider '${id}' already exists and is not managed by relay-models`, "error");
		return;
	}

	const rawName = await ctx.ui.input("Display name", managed?.name ?? id);
	if (rawName === undefined) return;
	const rawBaseUrl = await ctx.ui.input("Relay Base URL", managed?.baseUrl ?? "https://example.com/v1");
	if (rawBaseUrl === undefined) return;
	let baseUrl: string;
	try {
		baseUrl = normalizeBaseUrl(rawBaseUrl);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const config: RelayConfig = {
		id,
		name: rawName.trim() || id,
		baseUrl,
		protocol: managed?.protocol ?? "openai-completions",
		...(managed?.modelMappings ? { modelMappings: managed.modelMappings } : {}),
		...(managed?.protocolOverrides ? { protocolOverrides: managed.protocolOverrides } : {}),
		...(managed?.excludedModels ? { excludedModels: managed.excludedModels } : {}),
	};
	const confirmed = await ctx.ui.confirm(
		managed ? "Update relay provider?" : "Add relay provider?",
		`${config.name}\n${config.baseUrl}\nMixed protocols (auto-selected per model)`,
	);
	if (!confirmed) return;

	await saveAndRegister(pi, config);

	ctx.ui.notify(`Registered ${id}. Run /login ${id} to save the API key and fetch models.`, "info");
	ctx.ui.setEditorText(`/login ${id}`);
}

async function removeRelay(pi: ExtensionAPI, args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/relay-remove requires interactive or RPC UI mode", "error");
		return;
	}
	if (configFile.providers.length === 0) {
		ctx.ui.notify("No relay providers configured.", "info");
		return;
	}

	let providerId = args.trim();
	if (!providerId) {
		const selected = await ctx.ui.select(
			"Remove relay provider",
			configFile.providers.map((provider) => provider.id),
		);
		if (!selected) return;
		providerId = selected;
	}

	let normalizedId: string;
	try {
		normalizedId = validateProviderId(providerId);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		return;
	}
	const current = configFile.providers.find((provider) => provider.id === normalizedId);
	if (!current) {
		ctx.ui.notify(`Unknown relay provider: ${normalizedId}`, "error");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Remove relay provider?",
		`${current.name} (${current.id})\nThis also removes its stored credential and model cache.`,
	);
	if (!confirmed) return;

	await removeRelayForAi(pi, { providerId: normalizedId }, ctx);
	ctx.ui.notify(`Removed ${current.id}, its credential, and its model cache.`, "info");
}

function listRelays(ctx: ExtensionCommandContext): void {
	if (configFile.providers.length === 0) {
		ctx.ui.notify("No relay providers configured. Run /relay-add.", "info");
		return;
	}

	const lines = configFile.providers.map((config) => {
		const status = syncStatuses.get(config.id);
		const suffix = status ? ` — ${status.modelCount} models, ${status.matched} metadata matches` : " — not synced this run";
		return `${config.id} (mixed; fallback ${protocolDescription(config.protocol)})${suffix}`;
	});
	ctx.ui.notify(lines.join("\n"), "info");
}

async function syncRelays(ctx: ExtensionCommandContext): Promise<void> {
	if (configFile.providers.length === 0) {
		ctx.ui.notify("No relay providers configured. Run /relay-add.", "info");
		return;
	}

	refreshOfficialCatalog(ctx);
	ctx.ui.setStatus("relay-models", "syncing relay models…");
	try {
		await ctx.modelRegistry.refresh();
		const lines = relayReports().flatMap((report) => {
			if (report.modelCount === undefined) return [`${report.providerId}: skipped (run /login ${report.providerId})`];
			const routes = report.protocols
				? Object.entries(report.protocols)
						.filter(([, count]) => count > 0)
						.map(([protocol, count]) => `${protocol}=${count}`)
						.join(", ")
				: "";
			const summary = `${report.providerId}: ${report.modelCount} models, ${report.matched} matched, ${report.unmatched.length} unmatched${routes ? `; ${routes}` : ""}`;
			const unmatched = report.unmatched.slice(0, 20).map((id) => {
				const candidates = report.candidates[id] ?? [];
				const hint = candidates[0] ? ` → maybe ${candidates[0].provider}/${candidates[0].id}` : "";
				return `  - ${id}${hint}`;
			});
			return [summary, ...unmatched];
		});
		ctx.ui.notify(lines.join("\n"), "info");
	} finally {
		ctx.ui.setStatus("relay-models", undefined);
	}
}

export default async function relayModelsExtension(pi: ExtensionAPI) {
	try {
		configFile = await loadConfig();
		for (const config of configFile.providers) registerConfig(pi, config);
	} catch (error) {
		console.error(`[relay-models] ${error instanceof Error ? error.message : String(error)}`);
	}

	pi.on("session_start", (_event, ctx) => {
		const live = ctx.modelRegistry.getAll().filter((model) => builtinProviderIds.has(model.provider));
		if (live.length > 0) officialCatalog = live;
	});

	pi.registerTool({
		name: "relay_models",
		label: "Relay Models",
		description:
			"Configure mixed-protocol relay providers, remove providers and their stored state, sync model IDs, inspect unmatched IDs, atomically save one or more user-approved mappings, override a model protocol, and persistently exclude/include one or more relay models. This tool never accepts or exposes API keys; authentication must use /login.",
		promptSnippet: "Configure and review OpenAI/Anthropic relay model providers without exposing API keys",
		promptGuidelines: [
			"Use relay_models when the user asks to add, remove, or inspect an OpenAI/Anthropic-compatible relay provider.",
			"After relay_models add, tell the user to run the returned /login command; never ask the user to paste an API key into chat.",
			"Before calling relay_models with action=map, action=protocol, action=exclude, or action=remove, show every proposed change and obtain explicit user approval.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "remove", "sync", "status", "map", "protocol", "exclude", "include"] as const),
			baseUrl: Type.Optional(Type.String({ description: "Relay Base URL for action=add" })),
			protocol: Type.Optional(
				StringEnum(["openai-completions", "openai-responses", "anthropic-messages"] as const, {
					description: "Fallback for add, override for protocol/single map, or default for a mappings batch",
				}),
			),
			providerId: Type.Optional(Type.String({ description: "Relay provider ID for provider-scoped actions" })),
			displayName: Type.Optional(Type.String()),
			remoteModelId: Type.Optional(Type.String({ description: "Single remote model ID" })),
			remoteModelIds: Type.Optional(
				Type.Array(Type.String(), {
					description: "Remote model IDs to exclude/include in one operation",
					minItems: 1,
					uniqueItems: true,
				}),
			),
			officialProvider: Type.Optional(Type.String()),
			officialModelId: Type.Optional(Type.String()),
			mappings: Type.Optional(
				Type.Array(
					Type.Object({
						remoteModelId: Type.String(),
						officialProvider: Type.String(),
						officialModelId: Type.String(),
						protocol: Type.Optional(
							StringEnum(["openai-completions", "openai-responses", "anthropic-messages"] as const),
						),
					}),
					{
						description:
							"User-approved mappings to validate and save atomically; top-level protocol is the batch default",
						minItems: 1,
					},
				),
			),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Relay operation cancelled");
			onUpdate?.({ content: [{ type: "text", text: `Relay models: ${params.action}…` }], details: {} });
			let result: unknown;
			switch (params.action) {
				case "add":
					result = await addRelayForAi(pi, params, ctx);
					break;
				case "remove":
					result = await removeRelayForAi(pi, params, ctx);
					break;
				case "sync":
					refreshOfficialCatalog(ctx);
					await ctx.modelRegistry.refresh();
					result = relayReports(params.providerId);
					break;
				case "map":
					result = await mapRelayModels(pi, params, ctx);
					break;
				case "protocol":
					result = await setRelayModelProtocol(pi, params, ctx);
					break;
				case "exclude":
					result = await setRelayModelExclusion(pi, params, true, ctx);
					break;
				case "include":
					result = await setRelayModelExclusion(pi, params, false, ctx);
					break;
				default:
					result = relayReports(params.providerId);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
				details: result,
			};
		},
	});

	pi.registerCommand("relay-add", {
		description: "Add or update a relay provider",
		handler: async (_args, ctx) => addRelay(pi, ctx),
	});
	pi.registerCommand("relay-remove", {
		description: "Remove a relay provider and its stored state",
		getArgumentCompletions: (prefix) => {
			const matches = configFile.providers
				.filter((provider) => provider.id.startsWith(prefix))
				.map((provider) => ({ value: provider.id, label: provider.id, description: provider.name }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => removeRelay(pi, args, ctx),
	});
	pi.registerCommand("relay-sync", {
		description: "Refresh relay models and match pi metadata",
		handler: async (_args, ctx) => syncRelays(ctx),
	});
	pi.registerCommand("relay-list", {
		description: "List configured relay providers",
		handler: async (_args, ctx) => listRelays(ctx),
	});
}
