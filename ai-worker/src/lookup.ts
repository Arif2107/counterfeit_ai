import { z } from "zod";
import { FIXTURE_CAPTURED_AT, GREENBOOK_FIXTURE_RECORDS } from "./fixtures/greenbook";
import type { MedicineRecord, ReferenceLookupResult, ReferenceSource } from "./types";

const GREENBOOK_URL = "https://greenbook.nafdac.gov.ng/";
const TIMEOUT_MS = 15_000;
const PAGE_SIZE = 50;

// Column order used by the Greenbook DataTables request (observed in the browser).
const COLUMNS = [
	"product_name",
	"ingredient.ingredient_name",
	"product_category.name",
	"product_category_id",
	"ingredient.synonym",
	"NAFDAC",
	"form.name",
	"route.name",
	"strength",
	"applicant.name",
	"approval_date",
	"status",
];

const responseSchema = z.object({
	data: z.array(z.record(z.string(), z.unknown())),
	recordsFiltered: z.number().optional(),
});

/**
 * Cleans up a NAFDAC registration number: uppercase, unified dashes, label
 * prefixes like "NAFDAC REG. NO:" removed. A single space between two parts is
 * read as a lost dash ("04 2911" becomes "04-2911"); more than one is rejected,
 * since that usually means extra text. Returns null if it is not a plausible
 * registration number.
 */
export function normalizeNafdacNumber(input: string): string | null {
	const n = String(input ?? "")
		.normalize("NFKC")
		.toUpperCase()
		.trim()
		.replace(/[\u2010-\u2015\u2212]/g, "-")
		.replace(/^(NAFDAC\s*(REG(ISTRATION)?\.?)?\s*(NO\.?|NUMBER)?|REG(ISTRATION)?\.?\s*(NO\.?|NUMBER))\s*[:.\-]?\s*/, "")
		.replace(/\s*-\s*/g, "-")
		.replace(/\s+/, "-");

	if (n === "" || n.length > 20) return null;
	if (!/^[A-Z0-9]+(-[A-Z0-9]+)*$/.test(n)) return null;
	if (!/\d/.test(n)) return null;
	return n;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&#0*39;|&apos;/g, "'")
		.replace(/&quot;|&#0*34;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function text(v: unknown): string | null {
	if (typeof v !== "string" && typeof v !== "number") return null;
	const s = decodeEntities(String(v)).replace(/\s+/g, " ").trim();
	return s === "" ? null : s;
}

function first(...values: unknown[]): string | null {
	for (const v of values) {
		const t = text(v);
		if (t) return t;
	}
	return null;
}

function nested(rec: Record<string, unknown>, key: string, field: string): unknown {
	const o = rec[key];
	return o && typeof o === "object" ? (o as Record<string, unknown>)[field] : undefined;
}

function cleanName(v: unknown): string | null {
	const t = text(v);
	if (!t) return null;
	const c = t.replace(/\s*\*+$/, "").trim();
	return c === "" ? null : c;
}

function isoDate(v: unknown): string | null {
	const t = text(v);
	if (!t) return null;
	const m = t.match(/^(\d{4}-\d{2}-\d{2})/);
	return m ? m[1]! : t;
}

function toMedicineRecord(rec: Record<string, unknown>, today: string): MedicineRecord {
	const expiry = isoDate(rec.expiry_date);
	return {
		nafdacNumber: text(rec.NAFDAC) ?? "",
		productName: cleanName(rec.product_name),
		activeIngredient: first(nested(rec, "ingredient", "ingredient_name"), rec.ingredient_name),
		composition: text(rec.composition),
		strength: text(rec.strength),
		dosageForm: first(nested(rec, "form", "name"), rec.form_name),
		route: first(nested(rec, "route", "name"), rec.route_name),
		category: first(nested(rec, "product_category", "name"), rec.category_name),
		applicant: first(nested(rec, "applicant", "name"), rec.applicant_name),
		registrationStatus: text(rec.status),
		approvalDate: isoDate(rec.approval_date),
		registrationExpiry: expiry,
		registrationExpired: expiry && /^\d{4}-\d{2}-\d{2}$/.test(expiry) ? expiry < today : null,
		packSize: text(rec.pack_size),
		atcCode: text(rec.atc),
		productInfoUrl: text(rec.smpc),
	};
}

function makeSource(live: boolean, retrievedAt: string, gotAnswer: boolean): ReferenceSource {
	return {
		name: "NAFDAC Greenbook",
		type: live ? "greenbook_live" : "local_fixture",
		isLiveOfficialResult: live && gotAnswer,
		url: GREENBOOK_URL,
		retrievedAt,
		fixtureCapturedAt: live ? null : FIXTURE_CAPTURED_AT,
	};
}

// Mimics the Greenbook's own search: a plain "contains" match on the registration number.
function fixtureSearch(query: string): unknown {
	const q = query.toLowerCase();
	const data = GREENBOOK_FIXTURE_RECORDS.filter((r) =>
		String(r.NAFDAC ?? "")
			.toLowerCase()
			.includes(q),
	);
	return { draw: 1, recordsTotal: 8966, recordsFiltered: data.length, data };
}

function buildLiveUrl(query: string): string {
	const params = new URLSearchParams();
	params.set("draw", "1");
	COLUMNS.forEach((c, i) => {
		params.set(`columns[${i}][data]`, c);
		params.set(`columns[${i}][name]`, c);
		params.set(`columns[${i}][searchable]`, "true");
		params.set(`columns[${i}][orderable]`, i === 2 ? "false" : "true");
		params.set(`columns[${i}][search][value]`, "");
		params.set(`columns[${i}][search][regex]`, "false");
	});
	params.set("order[0][column]", "0");
	params.set("order[0][dir]", "asc");
	params.set("start", "0");
	params.set("length", String(PAGE_SIZE));
	params.set("search[value]", query);
	params.set("search[regex]", "false");
	params.set("search_ingredient", "");
	params.set("_", String(Date.now()));
	return `${GREENBOOK_URL}?${params.toString()}`;
}

// Only used when GREENBOOK_MODE is "live". Not enabled until automated access is confirmed as permitted.
async function liveSearch(query: string): Promise<unknown> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	try {
		const res = await fetch(buildLiveUrl(query), {
			headers: {
				Accept: "application/json, text/javascript, */*; q=0.01",
				"X-Requested-With": "XMLHttpRequest",
			},
			signal: controller.signal,
		});
		if (!res.ok) throw new Error(`Greenbook responded with HTTP ${res.status}`);
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

export async function lookupMedicine(nafdacNumber: string, env: Env): Promise<ReferenceLookupResult> {
	const normalized = normalizeNafdacNumber(nafdacNumber);
	if (!normalized) {
		return {
			status: "invalid_input",
			query: String(nafdacNumber ?? ""),
			reason: "Not a plausible NAFDAC registration number",
		};
	}

	const live = String(env.GREENBOOK_MODE ?? "fixture").trim().toLowerCase() === "live";
	const retrievedAt = new Date().toISOString();

	let raw: unknown;
	try {
		raw = live ? await liveSearch(normalized) : fixtureSearch(normalized);
	} catch (e) {
		const timedOut = e instanceof Error && e.name === "AbortError";
		const reason = timedOut
			? "Greenbook did not respond in time"
			: `Greenbook request failed: ${e instanceof Error ? e.message : String(e)}`;
		return {
			status: "source_unavailable",
			query: normalized,
			reason,
			source: makeSource(live, retrievedAt, false),
		};
	}

	const parsed = responseSchema.safeParse(raw);
	if (!parsed.success) {
		return {
			status: "source_unavailable",
			query: normalized,
			reason: "Greenbook returned an unexpected response format",
			source: makeSource(live, retrievedAt, false),
		};
	}

	const { data, recordsFiltered } = parsed.data;
	const hit = data.find((r) => normalizeNafdacNumber(text(r.NAFDAC) ?? "") === normalized);

	if (hit) {
		return {
			status: "match",
			query: normalized,
			record: toMedicineRecord(hit, retrievedAt.slice(0, 10)),
			source: makeSource(live, retrievedAt, true),
		};
	}

	// More results exist than we received, so the exact record might be on a later page.
	if ((recordsFiltered ?? 0) > data.length || data.length >= PAGE_SIZE) {
		return {
			status: "source_unavailable",
			query: normalized,
			reason: "Greenbook returned more results than could be checked",
			source: makeSource(live, retrievedAt, false),
		};
	}

	// The search is a text match, so a number that lost its dash cannot find "A6-100103".
	if (!normalized.includes("-")) {
		return {
			status: "source_unavailable",
			query: normalized,
			reason: "The number has no dash, so a missing result is not conclusive",
			source: makeSource(live, retrievedAt, false),
		};
	}

	return {
		status: "not_found",
		query: normalized,
		source: makeSource(live, retrievedAt, true),
	};
}

export function createLookupMedicine(env: Env): (nafdacNumber: string) => Promise<ReferenceLookupResult> {
	return (nafdacNumber) => lookupMedicine(nafdacNumber, env);
}