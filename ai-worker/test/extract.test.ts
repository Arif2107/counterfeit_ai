import { afterEach, describe, expect, it, vi } from "vitest";
import { extractProduct, parseModelOutput } from "../src/extract";
import { normalizeNafdacNumber } from "../src/lookup";
import { ExtractionError } from "../src/types";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);

function jpeg(): Blob {
	return new Blob([JPEG_BYTES], { type: "image/jpeg" });
}

function makeEnv(run: (...args: any[]) => Promise<unknown>): Env {
	return {
		AI: { run },
		GEMMA_MODEL: "test-model",
		MAX_IMAGE_BYTES: "5242880",
		ALLOWED_ORIGINS: "",
	} as unknown as Env;
}

function modelReply(content: string, finishReason = "stop") {
	return { choices: [{ message: { role: "assistant", content }, finish_reason: finishReason }] };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (e) {
		if (e instanceof ExtractionError) return e.code;
		throw e;
	}
	return "no_error";
}

afterEach(() => {
	vi.useRealTimers();
});

describe("parseModelOutput", () => {
	it("parses JSON wrapped in a code fence", () => {
		const text =
			'```json\n{"productName":"Maldox","brand":null,"category":null,"manufacturer":null,' +
			'"nafdacNumber":"04-2911","ingredients":["Sulfadoxine","Pyrimethamine"],"strength":"500/25mg",' +
			'"batchNumber":null,"manufacturingDate":null,"expiryDate":null}\n```';
		const r = parseModelOutput(text);
		expect(r.productName).toBe("Maldox");
		expect(r.nafdacNumber).toBe("04-2911");
		expect(r.ingredients).toEqual(["Sulfadoxine", "Pyrimethamine"]);
		expect(r.batchNumber).toBeNull();
	});

	it("normalises the NAFDAC number", () => {
		const r = parseModelOutput('{"nafdacNumber":"NAFDAC REG. NO: a6\u2013100103"}');
		expect(r.nafdacNumber).toBe("A6-100103");
	});

	it("turns placeholder strings into null", () => {
		const r = parseModelOutput('{"productName":"N/A","brand":"unknown","batchNumber":"  "}');
		expect(r.productName).toBeNull();
		expect(r.brand).toBeNull();
		expect(r.batchNumber).toBeNull();
	});

	it("rejects a NAFDAC number with uncertain characters", () => {
		const r = parseModelOutput('{"nafdacNumber":"A4-12?4"}');
		expect(r.nafdacNumber).toBeNull();
	});

	it("cleans the NAFDAC number the same way lookup does", () => {
		const cases: [string, string | null][] = [
			["Reg No: A4-1234", "A4-1234"],
			["04 2911", "04-2911"],
			["A4-1234 (batch 77)", null],
			["０４-２９１１", "04-2911"],
			["NO-1234", "NO-1234"],
		];
		for (const [input, expected] of cases) {
			const number = parseModelOutput(JSON.stringify({ nafdacNumber: input })).nafdacNumber;
			expect(number).toBe(expected);
			expect(normalizeNafdacNumber(input)).toBe(expected);
		}
	});

	it("keeps the printed date and adds a comparable month", () => {
		const cases: [string, string | null][] = [
			["03/2025", "2025-03"],
			["03/25", "2025-03"],
			["2025-03-14", "2025-03"],
			["2025/3", "2025-03"],
			["Mar 2025", "2025-03"],
			["March, 2025", "2025-03"],
			["14 Mar 2025", "2025-03"],
			["MFG 03/2025", "2025-03"],
			["EXP: 03/25", "2025-03"],
			["25/03/2025", "2025-03"],
			["12/06/2026", null],
			["13/2025", null],
			["soon", null],
		];
		for (const [input, month] of cases) {
			const r = parseModelOutput(JSON.stringify({ expiryDate: input }));
			expect(r.expiryDate).toBe(input);
			expect(r.expiryMonth).toBe(month);
		}
		expect(parseModelOutput('{"manufacturingDate":"01/24"}').manufacturingMonth).toBe("2024-01");
		expect(parseModelOutput("{}").expiryMonth).toBeNull();
	});

	it("does not split a chemical name on its comma", () => {
		const r = parseModelOutput('{"ingredients":"Vitamin B1, 1,2-propanediol; Zinc,Iron"}');
		expect(r.ingredients).toEqual(["Vitamin B1", "1,2-propanediol", "Zinc", "Iron"]);
	});

	it("rejects plain text", async () => {
		expect(() => parseModelOutput("I cannot read this image")).toThrowError(ExtractionError);
	});
});

describe("extractProduct", () => {
	it("returns structured data on success", async () => {
		const run = vi.fn().mockResolvedValue(
			modelReply('{"productName":"Maldox","nafdacNumber":"04-2911","ingredients":["Sulfadoxine"]}'),
		);
		const r = await extractProduct(jpeg(), makeEnv(run));
		expect(r.productName).toBe("Maldox");
		expect(r.nafdacNumber).toBe("04-2911");
		expect(r.expiryDate).toBeNull();
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("returns malformed_output when the model replies with prose", async () => {
		const run = vi.fn().mockResolvedValue(modelReply("Sorry, I can't see any product here."));
		expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("malformed_output");
	});

	it("returns malformed_output when the reply is cut off", async () => {
		const run = vi.fn().mockResolvedValue(modelReply('{"productName":"Mal', "length"));
		expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("malformed_output");
	});

	it("returns malformed_output for an empty reply", async () => {
		const run = vi.fn().mockResolvedValue(modelReply(""));
		expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("malformed_output");
	});

	it("returns rate_limited when the quota is used up", async () => {
		const run = vi
			.fn()
			.mockRejectedValue(new Error("AiError: 4006: you have used up your daily free allocation of 10,000 neurons"));
		expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("rate_limited");
	});

	it("returns rate_limited for the documented Workers AI 429 errors", async () => {
		for (const message of [
			"AiError: 3036: You have used up your daily free allocation of 10,000 neurons.",
			"AiError: 3040: Capacity temporarily exceeded, please try again.",
		]) {
			const run = vi.fn().mockRejectedValue(new Error(message));
			expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("rate_limited");
		}
	});

	it("does not mistake numbers inside other errors for a rate limit", async () => {
		for (const message of ["upstream returned 500 after 429ms", "AiError: 5018 request id 4294 failed", "id=a13040b failed"]) {
			const run = vi.fn().mockRejectedValue(new Error(message));
			expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("model_error");
		}
	});

	it("returns model_error for other failures", async () => {
		const run = vi.fn().mockRejectedValue(new Error("AiError: 5018: This account is not allowed to access this model"));
		expect(await codeOf(extractProduct(jpeg(), makeEnv(run)))).toBe("model_error");
	});

	it("returns timeout when the model never answers", async () => {
		vi.useFakeTimers();
		const run = vi.fn().mockReturnValue(new Promise(() => {}));
		const outcome = codeOf(extractProduct(jpeg(), makeEnv(run)));
		await vi.advanceTimersByTimeAsync(31_000);
		expect(await outcome).toBe("timeout");
	});

	it("rejects an oversized image without calling the model", async () => {
		const run = vi.fn();
		const env = { ...makeEnv(run), MAX_IMAGE_BYTES: "10" } as unknown as Env;
		const big = new Blob([new Uint8Array(100)], { type: "image/jpeg" });
		expect(await codeOf(extractProduct(big, env))).toBe("too_large");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects non-image bytes without calling the model", async () => {
		const run = vi.fn();
		const text = new Blob(["just some text"], { type: "image/jpeg" });
		expect(await codeOf(extractProduct(text, makeEnv(run)))).toBe("unsupported_type");
		expect(run).not.toHaveBeenCalled();
	});

	it("rejects an empty image without calling the model", async () => {
		const run = vi.fn();
		expect(await codeOf(extractProduct(new Blob([]), makeEnv(run)))).toBe("empty_image");
		expect(run).not.toHaveBeenCalled();
	});
});