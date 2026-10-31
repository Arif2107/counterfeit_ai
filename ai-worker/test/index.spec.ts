import { describe, expect, it } from "vitest";
import worker from "../src/index";

const env = { ALLOWED_ORIGINS: "http://localhost:3000" } as unknown as Env;
const devEnv = { ALLOWED_ORIGINS: "http://localhost:3000", ENABLE_DEV_ROUTES: "true" } as unknown as Env;
const ctx = {} as ExecutionContext;

function call(path: string, init?: RequestInit, e: Env = env) {
	return worker.fetch!(new Request(`http://example.com${path}`, init) as any, e, ctx);
}

describe("worker routes", () => {
	it("GET /api/health returns ok", async () => {
		const res = await call("/api/health");
		expect(res.status).toBe(200);
		const body: any = await res.json();
		expect(body.status).toBe("ok");
		expect(body.service).toBe("counterfeitiq-ai");
	});

	it("adds CORS headers for an allowed origin", async () => {
		const res = await call("/api/health", { headers: { Origin: "http://localhost:3000" } });
		expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
	});

	it("does not add CORS headers for a disallowed origin", async () => {
		const res = await call("/api/health", { headers: { Origin: "http://evil.com" } });
		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("answers a CORS preflight request with 204", async () => {
		const res = await call("/api/health", {
			method: "OPTIONS",
			headers: { Origin: "http://localhost:3000" },
		});
		expect(res.status).toBe(204);
	});

	it("returns 404 for unknown routes", async () => {
		const res = await call("/nope");
		expect(res.status).toBe(404);
	});
});

describe("developer test routes", () => {
	it("are hidden when ENABLE_DEV_ROUTES is not set", async () => {
		const res = await call("/api/dev/lookup?nafdac=A6-100103");
		expect(res.status).toBe(404);
	});

	it("are available when ENABLE_DEV_ROUTES is true", async () => {
		const res = await call("/api/dev/lookup?nafdac=A6-100103", undefined, devEnv);
		expect(res.status).toBe(200);
		const body: any = await res.json();
		expect(body.status).toBe("match");
		expect(body.source.type).toBe("local_fixture");
		expect(body.source.isLiveOfficialResult).toBe(false);
	});

	it("return 400 for an invalid number", async () => {
		const res = await call("/api/dev/lookup?nafdac=hello", undefined, devEnv);
		expect(res.status).toBe(400);
	});

	it("return 400 when no image is sent", async () => {
		const res = await call("/api/dev/extract", { method: "POST", body: new FormData() }, devEnv);
		expect(res.status).toBe(400);
		const body: any = await res.json();
		expect(body.error.code).toBe("missing_image");
	});

	it("map extraction errors to their HTTP status", async () => {
		const form = new FormData();
		form.append("image", new File(["just some text"], "a.jpg", { type: "image/jpeg" }));
		const res = await call("/api/dev/extract", { method: "POST", body: form }, devEnv);
		expect(res.status).toBe(415);
		const body: any = await res.json();
		expect(body.error.code).toBe("unsupported_type");
	});
});
