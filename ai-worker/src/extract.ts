import { z } from "zod";
import { maxImageBytes } from "./config";
import { normalizeNafdacNumber } from "./lookup";
import { ExtractionError, type ExtractedProduct } from "./types";

const TIMEOUT_MS = 30_000;

const PROMPT =
	"You are reading a photo of product packaging. Reply with ONLY one JSON object and no other text, " +
	"with exactly these keys: productName, brand, category, manufacturer, nafdacNumber, " +
	"ingredients (array of strings), strength, batchNumber, manufacturingDate, expiryDate. " +
	"Rules: Use null for any field that is not clearly and fully readable in the photo. " +
	"Never guess, infer, or fill in from your own knowledge (for example, do not list ingredients " +
	"that are not printed). Copy the NAFDAC registration number exactly as printed; if any " +
	"character is covered, blurred or uncertain, return null for it. Copy dates exactly as printed. " +
	"Use manufacturer only if the company name is clearly legible; if a logo is stylised or cut off, " +
	"return null. If several different products are visible, describe only the most prominent one.";

// Accept any JSON object. Each field is checked and cleaned individually below,
// and a missing key is treated the same as null.
const modelOutputSchema = z.record(z.string(), z.unknown());

const EMPTY_VALUES = new Set([
	"",
	"null",
	"n/a",
	"na",
	"none",
	"unknown",
	"not visible",
	"not readable",
	"unreadable",
	"-",
]);

const RATE_LIMIT_PATTERN = /\b(3036|3040|4006|429)\b|daily free allocation|neurons?\b|rate limit|too many requests|capacity/i;

const DATE_LABEL_PATTERN = /^(MFG|MFD|MANUFACTURED|MANUFACTURING|EXPIRY|EXPIRES|EXP|BEST BEFORE|USE BY)\.?\s*(DATE)?\.?\s*(ON|BY)?\s*[:.\-]?\s*/i;

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function snippet(text: string): string {
	const s = text.replace(/\s+/g, " ").trim();
	return s.length > 300 ? s.slice(0, 300) + "..." : s;
}

function cleanText(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "string" && typeof value !== "number") return null;
	const s = String(value).replace(/\s+/g, " ").trim();
	return EMPTY_VALUES.has(s.toLowerCase()) ? null : s;
}

function cleanNafdac(value: unknown): string | null {
	const s = cleanText(value);
	return s ? normalizeNafdacNumber(s) : null;
}

function yearMonth(year: string, month: number): string | null {
	if (month < 1 || month > 12) return null;
	const y = year.length === 2 ? `20${year}` : year;
	return `${y}-${String(month).padStart(2, "0")}`;
}

function monthIndex(name: string): number {
	return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

// Returns YYYY-MM, or null when the printed date cannot be read without guessing.
function parseMonth(printed: string | null): string | null {
	if (!printed) return null;
	const s = printed.replace(DATE_LABEL_PATTERN, "");

	let m = s.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{4}|\d{2})$/);
	if (m) return yearMonth(m[2]!, Number(m[1]));

	m = s.match(/^(\d{4})\s*[\/.\-]\s*(\d{1,2})(\s*[\/.\-]\s*\d{1,2})?$/);
	if (m) return yearMonth(m[1]!, Number(m[2]));

	// Day-first dates are only certain when the first number cannot be a month.
	m = s.match(/^(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})$/);
	if (m) return Number(m[1]) > 12 ? yearMonth(m[3]!, Number(m[2])) : null;

	m = s.match(/^(?:\d{1,2}\s*[,.\-\/]?\s*)?([A-Za-z]{3,9})\.?\s*[,.\-\/]?\s*(\d{4}|\d{2})$/);
	if (m) return yearMonth(m[2]!, monthIndex(m[1]!));

	return null;
}

function cleanIngredients(value: unknown): string[] | null {
	let items: string[] = [];
	if (Array.isArray(value)) {
		items = value.map((x) => cleanText(x)).filter((x): x is string => x !== null);
	} else if (typeof value === "string") {
		items = value
			// A comma between two digits is part of a name, as in "1,2-propanediol".
			.split(/;|,(?!\d)|(?<!\d),/)
			.map((x) => cleanText(x))
			.filter((x): x is string => x !== null);
	}
	return items.length > 0 ? items : null;
}

function detectMime(b: Uint8Array): "image/jpeg" | "image/png" | "image/webp" | null {
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (
		b.length >= 8 &&
		b[0] === 0x89 &&
		b[1] === 0x50 &&
		b[2] === 0x4e &&
		b[3] === 0x47 &&
		b[4] === 0x0d &&
		b[5] === 0x0a &&
		b[6] === 0x1a &&
		b[7] === 0x0a
	) {
		return "image/png";
	}
	if (
		b.length >= 12 &&
		b[0] === 0x52 &&
		b[1] === 0x49 &&
		b[2] === 0x46 &&
		b[3] === 0x46 &&
		b[8] === 0x57 &&
		b[9] === 0x45 &&
		b[10] === 0x42 &&
		b[11] === 0x50
	) {
		return "image/webp";
	}
	return null;
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}

export function parseModelOutput(text: string): ExtractedProduct {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) {
		throw new ExtractionError(
			"malformed_output",
			`Model reply contained no JSON object. Reply started: "${snippet(text)}"`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		throw new ExtractionError(
			"malformed_output",
			`Model reply was not valid JSON. Reply started: "${snippet(text)}"`,
		);
	}

	const result = modelOutputSchema.safeParse(parsed);
	if (!result.success) {
		throw new ExtractionError("malformed_output", "Model JSON was not an object");
	}

	const r = result.data;
	const manufacturingDate = cleanText(r["manufacturingDate"]);
	const expiryDate = cleanText(r["expiryDate"]);
	return {
		productName: cleanText(r["productName"]),
		brand: cleanText(r["brand"]),
		category: cleanText(r["category"]),
		manufacturer: cleanText(r["manufacturer"]),
		nafdacNumber: cleanNafdac(r["nafdacNumber"]),
		ingredients: cleanIngredients(r["ingredients"]),
		strength: cleanText(r["strength"]),
		batchNumber: cleanText(r["batchNumber"]),
		manufacturingDate,
		expiryDate,
		manufacturingMonth: parseMonth(manufacturingDate),
		expiryMonth: parseMonth(expiryDate),
	};
}

async function callModel(env: Env, dataUri: string): Promise<string> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new ExtractionError("timeout", `Model did not respond within ${TIMEOUT_MS / 1000}s`)),
			TIMEOUT_MS,
		);
	});

	try {
		const result: any = await Promise.race([
			env.AI.run(env.GEMMA_MODEL as any, {
				messages: [
					{
						role: "user",
						content: [
							{ type: "text", text: PROMPT },
							{ type: "image_url", image_url: { url: dataUri } },
						],
					},
				],
				max_tokens: 1000,
				temperature: 0,
				chat_template_kwargs: { enable_thinking: false },
			} as any),
			timeout,
		]);

		const choice = result?.choices?.[0];
		const content = choice?.message?.content;
		if (typeof content !== "string" || content.trim() === "") {
			throw new ExtractionError("malformed_output", "Model returned an empty reply");
		}
		if (choice?.finish_reason === "length") {
			throw new ExtractionError("malformed_output", "Model reply was cut off");
		}
		return content;
	} catch (e) {
		if (e instanceof ExtractionError) throw e;
		const message = String(e);
		if (RATE_LIMIT_PATTERN.test(message)) {
			throw new ExtractionError("rate_limited", message);
		}
		throw new ExtractionError("model_error", message);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

export async function extractProduct(image: File | Blob, env: Env): Promise<ExtractedProduct> {
	if (image.size === 0) {
		throw new ExtractionError("empty_image", "The image is empty");
	}
	if (image.size > maxImageBytes(env)) {
		throw new ExtractionError("too_large", `The image is larger than ${maxImageBytes(env)} bytes`);
	}

	const bytes = new Uint8Array(await image.arrayBuffer());
	const mime = detectMime(bytes);
	if (!mime) {
		throw new ExtractionError("unsupported_type", "Only JPEG, PNG and WebP images are accepted");
	}

	const dataUri = `data:${mime};base64,${toBase64(bytes)}`;
	const reply = await callModel(env, dataUri);
	return parseModelOutput(reply);
}

export function createExtractProduct(env: Env): (image: File | Blob) => Promise<ExtractedProduct> {
	return (image) => extractProduct(image, env);
}