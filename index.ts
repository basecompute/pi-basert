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
// Fallback context window when /props is unreachable or omits max_context.
const DEFAULT_CONTEXT_WINDOW = 8192;
// Hard cap on output tokens for models whose /props omits max_tokens. BaseRT
// generation is otherwise bounded only by the context window.
const DEFAULT_MAX_TOKENS = 16384;
const PROPS_TIMEOUT_MS = 120_000;

// GET /v1/models — BaseRT returns the OpenAI-shaped list, no per-model meta.
const ModelsResponseSchema = Type.Object({
	data: Type.Optional(
		Type.Array(
			Type.Object({
				id: Type.String(),
			}),
		),
	),
});

const validateModelsResponse = Compile(ModelsResponseSchema);

// GET /props — BaseRT's introspection snapshot. Server-global (single value
// shared by every loaded model), unlike llama.cpp's per-model props.
const PropsResponseSchema = Type.Object({
	default_generation_settings: Type.Optional(
		Type.Object({
			max_context: Type.Optional(Type.Number()),
			max_tokens: Type.Optional(Type.Number()),
		}),
	),
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

export default async function (pi: ExtensionAPI) {
	let currentModels: BaseRTModel[] = [];

	const baseUrl = (process.env.BASERT_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const apiKey = process.env.BASERT_API_KEY ?? "no-key";

	// BaseRT's /props and /v1/models go through check_auth: when the server is
	// started with --api-key, discovery fetches must carry the bearer token too.
	// When no key is configured the header is ignored, so always sending it is safe.
	const authHeaders: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
	const propsUrl = `${baseUrl.replace(/\/v1$/, "")}/props`;

	pi.registerCommand("basert-version", {
		description: "Get build info of the BaseRT server",
		handler: async (_args, ctx) => {
			const response = await fetch(propsUrl, { headers: authHeaders });
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
				// /v1/models carries no context window; preserve any value already
				// discovered from /props across refreshes, else fall back.
				const contextWindow = previous?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
				return {
					id: model.id,
					name: model.id,
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow,
					maxTokens: previous?.maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, contextWindow),
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

	// /props is server-global, so a single fetch resolves the context window and
	// output cap for every loaded model. Guarded so it runs at most once per
	// server unless a refresh clears it.
	let propsDiscovered = false;
	let pendingProps = false;
	let statusTimeout: ReturnType<typeof setTimeout> | undefined;

	function clearFooterStatusTimeout(): void {
		if (statusTimeout !== undefined) {
			clearTimeout(statusTimeout);
			statusTimeout = undefined;
		}
	}

	async function discoverProps(
		ctx?: ExtensionCtx,
		timeoutMs = PROPS_TIMEOUT_MS,
		selectedModel?: BaseRTModel,
	): Promise<void> {
		if (propsDiscovered) {
			// Re-registration does not refresh pi's active model snapshot, so copy
			// the already-discovered values into the selected model when available.
			if (selectedModel && currentModels.length > 0) {
				selectedModel.contextWindow = currentModels[0].contextWindow;
				selectedModel.maxTokens = currentModels[0].maxTokens;
			}
			return;
		}
		if (pendingProps) {
			return;
		}

		pendingProps = true;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

		try {
			const response = await fetch(propsUrl, { headers: authHeaders, signal: controller.signal });
			if (!response.ok) {
				ctx?.ui.notify(`[basert] /props returned ${response.status}`, "error");
				return;
			}
			const data: unknown = await response.json();
			if (!validatePropsResponse.Check(data)) {
				const errors = [...validatePropsResponse.Errors(data)]
					.map((e) => `${"path" in e ? e.path : ""} ${e.message}`)
					.join("; ");
				ctx?.ui.notify(`[basert] invalid /props response: ${errors}`, "error");
				return;
			}

			const maxContext = data.default_generation_settings?.max_context;
			const serverMaxTokens = data.default_generation_settings?.max_tokens;
			if (typeof maxContext === "number" && maxContext > 0) {
				const maxTokens =
					typeof serverMaxTokens === "number" && serverMaxTokens > 0
						? Math.min(serverMaxTokens, maxContext)
						: Math.min(DEFAULT_MAX_TOKENS, maxContext);
				for (const model of currentModels) {
					model.contextWindow = maxContext;
					model.maxTokens = maxTokens;
				}
				if (selectedModel) {
					selectedModel.contextWindow = maxContext;
					selectedModel.maxTokens = maxTokens;
				}
				if (ctx) {
					ctx.ui.setStatus(
						PROVIDER_ID,
						ctx.ui.theme.fg("dim", `[basert] context ${maxContext} tokens`),
					);
					clearFooterStatusTimeout();
					statusTimeout = setTimeout(() => {
						statusTimeout = undefined;
						ctx.ui.setStatus(PROVIDER_ID, undefined);
					}, 8000);
				}
			}

			propsDiscovered = true;

			pi.registerProvider(PROVIDER_ID, {
				name: "BaseRT",
				baseUrl,
				apiKey,
				api: "openai-completions",
				models: currentModels,
			});
		} catch (error) {
			const err = error as Error;
			const msg = err.name === "AbortError" ? "timeout" : err.message;
			ctx?.ui.notify(`[basert] /props failed: ${msg}`, "error");
		} finally {
			clearTimeout(timer);
			pendingProps = false;
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
		void discoverProps(ctx, PROPS_TIMEOUT_MS, event.model);
	});

	// Discover /props for already-active models because re-selecting them does not emit model_select.
	pi.on("before_provider_request", (event, ctx) => {
		const modelId = (event.payload as { model?: unknown })?.model;
		if (typeof modelId === "string") {
			const activeModel =
				ctx.model?.provider === PROVIDER_ID && ctx.model.id === modelId ? ctx.model : undefined;
			void discoverProps(ctx, PROPS_TIMEOUT_MS, activeModel);
		}
	});

	pi.on("session_shutdown", () => {
		clearFooterStatusTimeout();
	});
}
