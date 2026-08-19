/**
 * BaseRT provider for pi.
 *
 * Auto-discovers models from a running `basert serve` instance and
 * registers them under the `basert` provider.
 *
 * Usage: `pi install github.com/basecompute/pi-basert`
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";

const PROVIDER_ID = "basert";
const DEFAULT_BASE_URL = "http://localhost:8080/v1";
// Fallback for /v1/models entries missing meta.n_ctx.
const DEFAULT_CONTEXT_WINDOW = 8192;
// BaseRT generation is bounded only by the context window, so use pi's own
// default for models whose /props omits a max_tokens.
const DEFAULT_MAX_TOKENS = 16384;
// Until /props reveals the serve-enforced window, assume the smallest
// window `basert serve` launches with. /v1/models' n_ctx is the model's
// TRAINED window, which routinely exceeds what the running serve
// enforces — and the serve hard-rejects max_tokens above its window
// ("max_tokens must be an integer in [1, N]"), killing the whole turn
// with no tool calls and no reply. A too-small assumption merely costs
// one early compaction until discovery corrects it upward; a too-big
// one is a 400 on every request.
const PRE_DISCOVERY_CONTEXT_WINDOW = 4096;
const PRE_DISCOVERY_MAX_TOKENS = 4096;
// `basert serve`'s stock --max-tokens default. /props reports it whether
// or not the operator set one, so this exact value reads as "unset".
const SERVE_STOCK_MAX_TOKENS = 2048;
const PROPS_TIMEOUT_MS = 120_000;

// GET /v1/models — BaseRT surfaces per-model n_ctx + input modalities.
const ModelsResponseSchema = Type.Object({
	data: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
				// false for known-but-unloaded (autoload) models.
				loaded: Type.Optional(Type.Boolean()),
				architecture: Type.Optional(
					Type.Object({
						input_modalities: Type.Optional(Type.Array(Type.String())),
					}),
				),
				meta: Type.Optional(
					Type.Object({
						n_ctx: Type.Optional(Type.Number()),
					}),
				),
			}),
		),
	),
});

const validateModelsResponse = Compile(ModelsResponseSchema);

// GET /props?model=<id> — per-model snapshot with the raw chat template and
// the server's context window / output cap.
const PropsResponseSchema = Type.Object({
	default_generation_settings: Type.Optional(
		Type.Object({
			max_context: Type.Optional(Type.Number()),
			max_tokens: Type.Optional(Type.Number()),
		}),
	),
	// Present only when /props was queried with ?model=. False when the model
	// is known but not yet loaded (and chat_template is then omitted).
	loaded: Type.Optional(Type.Boolean()),
	chat_template: Type.Optional(Type.String()),
	build: Type.Optional(
		Type.Object({
			version: Type.Optional(Type.String()),
			target: Type.Optional(Type.String()),
		}),
	),
});

const validatePropsResponse = Compile(PropsResponseSchema);

type BaseRTModel = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["models"]>[number];
type ExtensionCtx = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];

// BaseRT template thinking is a boolean toggle, so expose pi's off/medium switch only.
const TEMPLATE_THINKING_LEVEL_MAP = {
	minimal: null,
	low: null,
	high: null,
	xhigh: null,
} satisfies NonNullable<BaseRTModel["thinkingLevelMap"]>;

// Minimal shape needed to update both registered models and pi's active model snapshot.
type MutableModelMetadata = {
	reasoning: boolean;
	thinkingLevelMap?: BaseRTModel["thinkingLevelMap"];
	compat?: BaseRTModel["compat"];
	contextWindow: number;
	maxTokens: number;
};

// Mark a model as using the chat template's enable_thinking control.
function applyTemplateThinkingSupport(model: MutableModelMetadata): void {
	model.reasoning = true;
	model.thinkingLevelMap = TEMPLATE_THINKING_LEVEL_MAP;
	model.compat = {
		...model.compat,
		// Sends the generic chat_template_kwargs.enable_thinking payload.
		thinkingFormat: "qwen-chat-template",
	};
}

export default async function (pi: ExtensionAPI) {
	let currentModels: BaseRTModel[] = [];

	const baseUrl = (process.env.BASERT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const apiKey = process.env.BASERT_API_KEY ?? "no-key";

	// BaseRT's /props and /v1/models go through check_auth: when the server is
	// started with --api-key, discovery fetches must carry the bearer token too.
	// When no key is configured the header is ignored, so always sending it is safe.
	const authHeaders: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	const propsBase = baseUrl.replace(/\/v1$/, "");

	// WORKAROUND for a basert-serve template bug: older chat templates
	// (Qwen3 0.6B/4B/8B era) render OpenAI structured content arrays as
	// garbage — the model literally never sees the user's message and
	// confabulates one ("waiting for your query…"), which broke coding on
	// exactly those models while Qwen3.5-era templates and cloud
	// providers worked. pi always sends content as arrays, so until the
	// serve flattens them itself, rewrite text-only content arrays into
	// plain strings on every chat request to this provider. Messages with
	// image parts pass through untouched.
	function flattenTextContent(body: string): string {
		try {
			const payload = JSON.parse(body) as { messages?: Array<{ content?: unknown }> };
			if (!Array.isArray(payload?.messages)) {
				return body;
			}
			let changed = false;
			for (const message of payload.messages) {
				const content = message?.content;
				if (
					Array.isArray(content) &&
					content.length > 0 &&
					content.every(
						(part) =>
							typeof part === "object" &&
							part !== null &&
							(part as { type?: string }).type === "text" &&
							typeof (part as { text?: unknown }).text === "string",
					)
				) {
					message.content = content.map((part) => (part as { text: string }).text).join("\n\n");
					changed = true;
				}
			}
			return changed ? JSON.stringify(payload) : body;
		} catch {
			return body;
		}
	}

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		if (
			init?.method === "POST" &&
			typeof init.body === "string" &&
			url.startsWith(baseUrl) &&
			url.includes("/chat/completions")
		) {
			init = { ...init, body: flattenTextContent(init.body) };
		}
		return originalFetch(input, init);
	}) as typeof fetch;

	pi.registerCommand("basert-version", {
		description: "Get build info of the BaseRT server",
		handler: async (_args, ctx) => {
			const response = await fetch(`${propsBase}/props`, { headers: authHeaders });
			if (!response.ok) {
				ctx.ui.notify(`[basert] /props returned ${response.status}`, "error");
				return;
			}

			const data: unknown = await response.json();
			if (!validatePropsResponse.Check(data)) {
				const errors = [...validatePropsResponse.Errors(data)]
					.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
					.join("; ");
				ctx.ui.notify(`[basert] invalid /props response: ${errors}`, "error");
				return;
			}

			const version = data.build?.version;
			const target = data.build?.target;
			if (version) {
				ctx.ui.notify(`BaseRT ${version}${target ? ` (${target})` : ""}`, "info");
			} else {
				ctx.ui.notify("BaseRT server reachable, but /props omitted build info", "warning");
			}
		},
	});

	async function refreshProvider(): Promise<void> {
		try {
			const response = await fetch(`${baseUrl}/models`, { headers: authHeaders });
			if (!response.ok) {
				console.warn(`[basert] ${baseUrl}/models returned ${response.status}`);
				return;
			}

			const payload: unknown = await response.json();
			if (!validateModelsResponse.Check(payload)) {
				const errors = [...validateModelsResponse.Errors(payload)]
					.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
					.join("; ");
				console.warn(`[basert] invalid /models response: ${errors}`);
				return;
			}

			const previousById = new Map(currentModels.map((m) => [m.id, m]));

			currentModels = (payload.data ?? []).map((model) => {
				const previous = previousById.get(model.id);
				const modalities = model.architecture?.input_modalities ?? ["text"];
				const input = modalities.filter(
					(m): m is "text" | "image" => m === "text" || m === "image",
				);
				const suffixes: string[] = [];
				if (input.includes("image")) {
					suffixes.push("(image)");
				}
				// Surface autoload state: unmarked = resident, "(unloaded)" = will
				// load into VRAM on first use. `loaded` is omitted by older servers,
				// in which case we say nothing rather than guess.
				if (model.loaded === false) {
					suffixes.push("(unloaded)");
				}
				// `previous` first: it carries the /props-discovered window,
				// which a list refresh must not revert to the trained n_ctx.
				// Before discovery, clamp to the pre-discovery floor — n_ctx
				// only ever LOWERS the assumption (a model trained under 4k
				// stays under it).
				const contextWindow =
					previous?.contextWindow ??
					Math.min(model.meta?.n_ctx ?? DEFAULT_CONTEXT_WINDOW,
						PRE_DISCOVERY_CONTEXT_WINDOW);
				return {
					id: model.id,
					name: suffixes.length > 0 ? `${model.id} ${suffixes.join(" ")}` : model.id,
					// /v1/models does not include /props-discovered capabilities, so preserve
					// template thinking metadata across refreshes.
					reasoning: previous?.reasoning ?? false,
					thinkingLevelMap: previous?.thinkingLevelMap,
					input,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: previous?.maxTokens
						?? Math.min(PRE_DISCOVERY_MAX_TOKENS, contextWindow),
					compat: previous?.compat,
				} as BaseRTModel;
			});

			if (currentModels.length === 0) {
				console.warn(`[basert] no models returned from ${baseUrl}/models`);
				return;
			}

			pi.registerProvider(PROVIDER_ID, {
				name: "BaseRT",
				baseUrl,
				apiKey,
				api: "openai-completions",
				models: currentModels,
			});
		} catch (error) {
			console.warn(`[basert] failed to reach ${baseUrl}/models: ${(error as Error).message}`);
		}
	}

	const discoveredMetadata = new Set<string>();
	const pendingMetadata = new Set<string>();
	let statusTimeout: ReturnType<typeof setTimeout> | undefined;

	function clearFooterStatusTimeout(): void {
		if (statusTimeout !== undefined) {
			clearTimeout(statusTimeout);
			statusTimeout = undefined;
		}
	}

	async function discoverModelMetadata(
		modelId: string,
		ctx?: ExtensionCtx,
		timeoutMs = PROPS_TIMEOUT_MS,
		selectedModel?: MutableModelMetadata,
	): Promise<void> {
		const model = currentModels.find((m) => m.id === modelId);
		if (!model) {
			return;
		}
		if (discoveredMetadata.has(modelId)) {
			// Provider re-registration does not update pi's active model snapshot, so copy
			// already-discovered metadata into the selected model when available.
			if (selectedModel) {
				selectedModel.contextWindow = model.contextWindow;
				selectedModel.maxTokens = model.maxTokens;
				if (model.reasoning) {
					selectedModel.reasoning = model.reasoning;
					selectedModel.thinkingLevelMap = model.thinkingLevelMap;
					selectedModel.compat = model.compat;
				}
			}
			return;
		}
		if (pendingMetadata.has(modelId)) {
			return;
		}

		pendingMetadata.add(modelId);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		// autoload=1 brings a known-but-unloaded model into VRAM so we can read
		// its real template/context now — and it's warm for the first request.
		const propsUrl = `${propsBase}/props?model=${encodeURIComponent(modelId)}&autoload=1`;

		try {
			if (ctx) {
				ctx.ui.setStatus(PROVIDER_ID, ctx.ui.theme.fg("dim", `[basert] loading: ${modelId}`));
			}
			const response = await fetch(propsUrl, { headers: authHeaders, signal: controller.signal });
			if (!response.ok) {
				ctx?.ui.setStatus(PROVIDER_ID, undefined);
				ctx?.ui.notify(`[basert] /props for ${modelId} returned ${response.status}`, "error");
				return;
			}
			const data: unknown = await response.json();
			if (!validatePropsResponse.Check(data)) {
				ctx?.ui.setStatus(PROVIDER_ID, undefined);
				const errors = [...validatePropsResponse.Errors(data)]
					.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
					.join("; ");
				ctx?.ui.notify(`[basert] invalid /props response for ${modelId}: ${errors}`, "error");
				return;
			}

			let updated = false;
			// Model is resident now (autoload=1 loaded it) — drop the "(unloaded)"
			// tag from its label so the picker reflects reality.
			if (data.loaded === true && model.name.includes("(unloaded)")) {
				model.name = model.name.replace(" (unloaded)", "");
				updated = true;
			}

			const maxContext = data.default_generation_settings?.max_context;
			const serverMaxTokens = data.default_generation_settings?.max_tokens;
			let footerStatus = data.loaded === true ? `[basert] ${modelId} loaded` : undefined;
			if (typeof maxContext === "number" && maxContext > 0) {
				model.contextWindow = maxContext;
				// default_generation_settings.max_tokens is what the serve
				// applies to requests that OMIT max_tokens — not a request
				// ceiling (the ceiling is the window). Honoring the stock
				// default would cap every agent turn at 2048 tokens on a
				// 32k window, and thinking models burn that on reasoning
				// before emitting a tool call — an empty turn with no
				// calls and no reply. Only a non-stock value is an
				// operator's explicit cap.
				model.maxTokens =
					typeof serverMaxTokens === "number" && serverMaxTokens > 0
						&& serverMaxTokens !== SERVE_STOCK_MAX_TOKENS
						? Math.min(serverMaxTokens, maxContext)
						: Math.min(DEFAULT_MAX_TOKENS, maxContext);
				footerStatus = `[basert] ${modelId} loaded (context ${maxContext} tokens)`;
				updated = true;
			}
			if (selectedModel) {
				selectedModel.contextWindow = model.contextWindow;
				selectedModel.maxTokens = model.maxTokens;
			}
			if (data.chat_template?.includes("enable_thinking") === true) {
				applyTemplateThinkingSupport(model);
				if (selectedModel) {
					applyTemplateThinkingSupport(selectedModel);
					if (pi.getThinkingLevel() === "off") {
						pi.setThinkingLevel("medium");
					}
				}
				updated = true;
			}
			discoveredMetadata.add(modelId);
			if (ctx) {
				if (footerStatus) {
					// Briefly show the loaded/context line, then clear the loading status.
					ctx.ui.setStatus(PROVIDER_ID, ctx.ui.theme.fg("dim", footerStatus));
					clearFooterStatusTimeout();
					statusTimeout = setTimeout(() => {
						statusTimeout = undefined;
						ctx.ui.setStatus(PROVIDER_ID, undefined);
					}, 8000);
				} else {
					// Nothing to report — clear the "loading…" status we set above.
					ctx.ui.setStatus(PROVIDER_ID, undefined);
				}
			}
			if (!updated) {
				return;
			}
			pi.registerProvider(PROVIDER_ID, {
				name: "BaseRT",
				baseUrl,
				apiKey,
				api: "openai-completions",
				models: currentModels,
			});
		} catch (error) {
			ctx?.ui.setStatus(PROVIDER_ID, undefined);
			const err = error as Error;
			const msg = err.name === "AbortError" ? "timeout" : err.message;
			ctx?.ui.notify(`[basert] /props for ${modelId} failed: ${msg}`, "error");
		} finally {
			clearTimeout(timer);
			pendingMetadata.delete(modelId);
		}
	}

	await refreshProvider();

	pi.on("input", async (event) => {
		const trimmed = event.text.trim().toLowerCase();
		if (trimmed === "/model") {
			await refreshProvider();
		}
	});

	pi.on("model_select", (event, ctx) => {
		if (event.model.provider !== PROVIDER_ID) {
			return;
		}
		void discoverModelMetadata(event.model.id, ctx, PROPS_TIMEOUT_MS, event.model);
	});

	// Discover /props for already-active models because re-selecting them does not emit model_select.
	pi.on("before_provider_request", (event, ctx) => {
		const modelId = (event.payload as { model?: unknown })?.model;
		if (typeof modelId === "string") {
			const activeModel =
				ctx.model?.provider === PROVIDER_ID && ctx.model.id === modelId ? ctx.model : undefined;
			void discoverModelMetadata(modelId, ctx, PROPS_TIMEOUT_MS, activeModel);
		}
	});

	pi.on("session_shutdown", () => {
		clearFooterStatusTimeout();
	});
}
