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
	fetchModelIds,
	materializeRelayModels,
	normalizeBaseUrl,
	spoofHeadersForModel,
	suggestOfficialCandidates,
	suggestProviderIdentity,
	type RelayConfig,
	type RelayModelResponse,
	type RelayProtocol,
	validateProviderId,
} from "./core.ts";
import { SPOOF_HEADER_PROFILES } from "./header-profiles.ts";

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

const CONFIG_PATH = join(getAgentDir(), "relay-providers.json");
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

async function mapRelayModel(
	pi: ExtensionAPI,
	params: {
		providerId?: string;
		remoteModelId?: string;
		officialProvider?: string;
		officialModelId?: string;
		protocol?: RelayProtocol;
	},
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	const { providerId, remoteModelId, officialProvider, officialModelId } = params;
	if (!providerId || !remoteModelId || !officialProvider || !officialModelId) {
		throw new Error("providerId, remoteModelId, officialProvider, and officialModelId are required for action=map");
	}
	refreshOfficialCatalog(ctx);
	const official = officialCatalog.find((model) => model.provider === officialProvider && model.id === officialModelId);
	if (!official) throw new Error(`Official model not found: ${officialProvider}/${officialModelId}`);
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);

	const config: RelayConfig = {
		...current,
		modelMappings: {
			...(current.modelMappings ?? {}),
			[remoteModelId]: { provider: officialProvider, id: officialModelId },
		},
		...(params.protocol
			? { protocolOverrides: { ...(current.protocolOverrides ?? {}), [remoteModelId]: params.protocol } }
			: {}),
	};
	await saveAndRegister(pi, config);
	await ctx.modelRegistry.refresh();
	return {
		mapped: `${providerId}/${remoteModelId}`,
		metadataSource: `${officialProvider}/${officialModelId}`,
		protocolOverride: params.protocol,
		report: relayReports(providerId)[0],
	};
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
	params: { providerId?: string; remoteModelId?: string },
	excluded: boolean,
	ctx: Pick<ExtensionCommandContext, "modelRegistry">,
) {
	const { providerId, remoteModelId } = params;
	if (!providerId || !remoteModelId) throw new Error("providerId and remoteModelId are required");
	const current = configFile.providers.find((provider) => provider.id === providerId);
	if (!current) throw new Error(`Unknown relay provider: ${providerId}`);
	const values = new Set(current.excludedModels ?? []);
	if (excluded) values.add(remoteModelId);
	else values.delete(remoteModelId);
	const config: RelayConfig = {
		...current,
		...(values.size > 0 ? { excludedModels: [...values].sort() } : { excludedModels: undefined }),
	};
	await saveAndRegister(pi, config);
	await ctx.modelRegistry.refresh();
	return { model: `${providerId}/${remoteModelId}`, excluded, report: relayReports(providerId)[0] };
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
			"Configure mixed-protocol relay providers, sync model IDs, inspect unmatched IDs, save user-approved mappings, override a model protocol, and persistently exclude/include relay models. This tool never accepts or exposes API keys; authentication must use /login.",
		promptSnippet: "Configure and review OpenAI/Anthropic relay model providers without exposing API keys",
		promptGuidelines: [
			"Use relay_models when the user asks to add or inspect an OpenAI/Anthropic-compatible relay provider.",
			"After relay_models add, tell the user to run the returned /login command; never ask the user to paste an API key into chat.",
			"Before calling relay_models with action=map, action=protocol, or action=exclude, show the proposed change and obtain explicit user approval.",
		],
		parameters: Type.Object({
			action: StringEnum(["add", "sync", "status", "map", "protocol", "exclude", "include"] as const),
			baseUrl: Type.Optional(Type.String({ description: "Relay Base URL for action=add" })),
			protocol: Type.Optional(
				StringEnum(["openai-completions", "openai-responses", "anthropic-messages"] as const, {
					description: "Optional unmatched-model fallback for add, or explicit per-model override for map/protocol",
				}),
			),
			providerId: Type.Optional(Type.String()),
			displayName: Type.Optional(Type.String()),
			remoteModelId: Type.Optional(Type.String()),
			officialProvider: Type.Optional(Type.String()),
			officialModelId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (signal?.aborted) throw new Error("Relay operation cancelled");
			onUpdate?.({ content: [{ type: "text", text: `Relay models: ${params.action}…` }], details: {} });
			let result: unknown;
			switch (params.action) {
				case "add":
					result = await addRelayForAi(pi, params, ctx);
					break;
				case "sync":
					refreshOfficialCatalog(ctx);
					await ctx.modelRegistry.refresh();
					result = relayReports(params.providerId);
					break;
				case "map":
					result = await mapRelayModel(pi, params, ctx);
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
	pi.registerCommand("relay-sync", {
		description: "Refresh relay models and match pi metadata",
		handler: async (_args, ctx) => syncRelays(ctx),
	});
	pi.registerCommand("relay-list", {
		description: "List configured relay providers",
		handler: async (_args, ctx) => listRelays(ctx),
	});
}
