import { maxImageBytes } from "./config";
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

const PUBLIC_MESSAGES: Record<ExtractionErrorCode, string> = {
	empty_image: "The image is empty",
	unsupported_type: "Only JPEG, PNG and WebP images are accepted",
	too_large: "The image is too large",
	timeout: "Reading the photo took too long",
	rate_limited: "Too many requests. Try again in a minute",
	model_error: "The photo could not be read right now",
	malformed_output: "The photo could not be read",
};

// Room for the multipart boundary and part headers around the image.
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

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

async function allowed(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
	if (!limiter) return true;
	// Shoppers are anonymous, so the IP is the only key available. Limits are generous because
	// mobile networks share addresses.
	const key = request.headers.get("cf-connecting-ip") ?? "unknown";
	const { success } = await limiter.limit({ key });
	return success;
}

function rateLimited(cors: Record<string, string>): Response {
	return json(
		{ ok: false, error: { code: "rate_limited", message: PUBLIC_MESSAGES.rate_limited } },
		429,
		{ ...cors, "Retry-After": "60" },
	);
}

function missingImage(cors: Record<string, string>): Response {
	return json(
		{ ok: false, error: { code: "missing_image", message: "Send multipart/form-data with an 'image' field" } },
		400,
		cors,
	);
}

async function handleExtract(
	request: Request,
	env: Env,
	cors: Record<string, string>,
	detailedErrors: boolean,
): Promise<Response> {
	if (!(await allowed(env.EXTRACT_LIMITER, request))) return rateLimited(cors);

	// Refuse an oversized upload before formData() reads all of it into memory.
	const declared = Number(request.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxImageBytes(env) + MULTIPART_OVERHEAD_BYTES) {
		return json({ ok: false, error: { code: "too_large", message: PUBLIC_MESSAGES.too_large } }, 413, cors);
	}

	let file: unknown;
	try {
		const form = await request.formData();
		file = form.get("image");
	} catch {
		return missingImage(cors);
	}
	if (!(file instanceof File)) return missingImage(cors);

	try {
		const data = await extractProduct(file, env);
		return json({ ok: true, data }, 200, cors);
	} catch (e) {
		if (e instanceof ExtractionError) {
			console.error("extraction failed", e.code, e.message);
			const message = detailedErrors ? e.message : PUBLIC_MESSAGES[e.code];
			return json({ ok: false, error: { code: e.code, message } }, ERROR_STATUS[e.code], cors);
		}
		console.error("extraction crashed", e);
		const message = detailedErrors ? String(e) : "Something went wrong";
		return json({ ok: false, error: { code: "internal_error", message } }, 500, cors);
	}
}

async function handleLookup(request: Request, url: URL, env: Env, cors: Record<string, string>): Promise<Response> {
	if (!(await allowed(env.LOOKUP_LIMITER, request))) return rateLimited(cors);

	const number = url.searchParams.get("nafdac") ?? "";
	const result = await lookupMedicine(number, env);
	const status =
		result.status === "invalid_input" ? 400 : result.status === "source_unavailable" ? 503 : 200;
	return json(result, status, cors);
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

		if (url.pathname === "/api/extract" && request.method === "POST") {
			return handleExtract(request, env, cors, false);
		}

		if (url.pathname === "/api/lookup" && request.method === "GET") {
			return handleLookup(request, url, env, cors);
		}

		// Developer test routes show full error details. Off unless ENABLE_DEV_ROUTES is "true" (local only, via .dev.vars).
		if (devRoutesEnabled(env)) {
			if (url.pathname === "/api/dev/extract" && request.method === "POST") {
				return handleExtract(request, env, cors, true);
			}

			if (url.pathname === "/api/dev/lookup" && request.method === "GET") {
				return handleLookup(request, url, env, cors);
			}
		}

		return json({ error: "not_found" }, 404, cors);
	},
} satisfies ExportedHandler<Env>;
