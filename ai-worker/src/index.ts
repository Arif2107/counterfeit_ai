import { extractProduct } from "./extract";
import { lookupMedicine } from "./lookup";
import { ExtractionError, type ExtractionErrorCode } from "./types";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const ERROR_STATUS: Record<ExtractionErrorCode, number> = {
	empty_image: 400,
	unsupported_type: 415,
	too_large: 413,
	timeout: 504,
	rate_limited: 429,
	model_error: 502,
	malformed_output: 502,
};

function corsHeaders(request: Request, env: Env): Record<string, string> {
	const origin = request.headers.get("Origin");
	const allowed = (env.ALLOWED_ORIGINS ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	const headers: Record<string, string> = { Vary: "Origin" };
	if (origin && allowed.includes(origin)) {
		headers["Access-Control-Allow-Origin"] = origin;
		headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
		headers["Access-Control-Allow-Headers"] = "Content-Type";
		headers["Access-Control-Max-Age"] = "86400";
	}
	return headers;
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { ...JSON_HEADERS, ...extra },
	});
}

function devRoutesEnabled(env: Env): boolean {
	return String(env.ENABLE_DEV_ROUTES ?? "").trim().toLowerCase() === "true";
}

export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		const cors = corsHeaders(request, env);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: cors });
		}

		if (url.pathname === "/api/health" && request.method === "GET") {
			return json(
				{ status: "ok", service: "counterfeitiq-ai", time: new Date().toISOString() },
				200,
				cors,
			);
		}

		// Developer test routes. Off unless ENABLE_DEV_ROUTES is "true" (local only, via .dev.vars).
		if (devRoutesEnabled(env)) {
			if (url.pathname === "/api/dev/extract" && request.method === "POST") {
				let file: unknown;
				try {
					const form = await request.formData();
					file = form.get("image");
				} catch {
					return json(
						{ ok: false, error: { code: "missing_image", message: "Send multipart/form-data with an 'image' field" } },
						400,
						cors,
					);
				}
				if (!(file instanceof File)) {
					return json(
						{ ok: false, error: { code: "missing_image", message: "Send multipart/form-data with an 'image' field" } },
						400,
						cors,
					);
				}

				try {
					const data = await extractProduct(file, env);
					return json({ ok: true, data }, 200, cors);
				} catch (e) {
					if (e instanceof ExtractionError) {
						return json(
							{ ok: false, error: { code: e.code, message: e.message } },
							ERROR_STATUS[e.code],
							cors,
						);
					}
					return json({ ok: false, error: { code: "internal_error", message: String(e) } }, 500, cors);
				}
			}

			if (url.pathname === "/api/dev/lookup" && request.method === "GET") {
				const number = url.searchParams.get("nafdac") ?? "";
				const result = await lookupMedicine(number, env);
				const status =
					result.status === "invalid_input" ? 400 : result.status === "source_unavailable" ? 503 : 200;
				return json(result, status, cors);
			}
		}

		return json({ error: "not_found" }, 404, cors);
	},
} satisfies ExportedHandler<Env>;