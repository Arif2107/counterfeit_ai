import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupMedicine, normalizeNafdacNumber } from "../src/lookup";

function makeEnv(mode?: string): Env {
	return { GREENBOOK_MODE: mode } as unknown as Env;
}

function rec(nafdac: string, name = "Test Product") {
	return {
		NAFDAC: nafdac,
		product_name: name,
		strength: "500 mg",
		status: "Active",
		approval_date: "2024-01-01",
		expiry_date: "2029-01-01",
		applicant: { name: "Test Applicant Ltd" },
	};
}

function stubLiveResponse(body: unknown, status = 200) {
	const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("normalizeNafdacNumber", () => {
	it("uppercases and trims", () => {
		expect(normalizeNafdacNumber("  a6-100103 ")).toBe("A6-100103");
	});

	it("unifies dash characters and removes spaces", () => {
		expect(normalizeNafdacNumber("A6 \u2013 100103")).toBe("A6-100103");
	});

	it("removes a label prefix", () => {
		expect(normalizeNafdacNumber("NAFDAC REG. NO: 04-2911")).toBe("04-2911");
		expect(normalizeNafdacNumber("nafdac reg no. a4-1234")).toBe("A4-1234");
	});

	it("removes a label without the NAFDAC word, but keeps numbers that only look like one", () => {
		expect(normalizeNafdacNumber("Reg No: A4-1234")).toBe("A4-1234");
		expect(normalizeNafdacNumber("NO-1234")).toBe("NO-1234");
	});

	it("reads a single space as a lost dash and rejects extra text", () => {
		expect(normalizeNafdacNumber("04 2911")).toBe("04-2911");
		expect(normalizeNafdacNumber("NAFDAC REG. NO. 04 2911")).toBe("04-2911");
		expect(normalizeNafdacNumber("04-2911 BATCH 77")).toBeNull();
	});

	it("rejects implausible input", () => {
		expect(normalizeNafdacNumber("")).toBeNull();
		expect(normalizeNafdacNumber("hello")).toBeNull();
		expect(normalizeNafdacNumber("A6-")).toBeNull();
		expect(normalizeNafdacNumber("A6--100")).toBeNull();
		expect(normalizeNafdacNumber("NAFDAC")).toBeNull();
		expect(normalizeNafdacNumber("???")).toBeNull();
	});
});

describe("lookupMedicine in fixture mode (default)", () => {
	it("matches the known test number and labels the result as a fixture", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		const r = await lookupMedicine("A6-100103", makeEnv());
		expect(r.status).toBe("match");
		if (r.status !== "match") return;

		expect(r.record.nafdacNumber).toBe("A6-100103");
		expect(r.record.productName).toBe("Recombinant Hepatitis B Vaccine 0.5 mL (Pediatric)");
		expect(r.record.activeIngredient).toBe("Hepatitis B vaccine");
		expect(r.record.strength).toBe("10 mcg/0.5 mL");
		expect(r.record.dosageForm).toBe("Suspension for injection");
		expect(r.record.applicant).toBe("Biovaccines Nigeria Ltd");
		expect(r.record.registrationStatus).toBe("Active");
		expect(r.record.approvalDate).toBe("2023-06-04");
		expect(r.record.registrationExpiry).toBe("2028-05-30");
		expect(r.record.packSize).toBe("0.5 mL x 10's (in Pre-filled syringes) + 1 sterile needle (25G x 5/8')");

		expect(r.source.type).toBe("local_fixture");
		expect(r.source.isLiveOfficialResult).toBe(false);
		expect(r.source.fixtureCapturedAt).toBe("2026-10-31");
		expect(r.source.retrievedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("matches messy input", async () => {
		for (const input of ["a6-100103", " A6 \u2013 100103 ", "NAFDAC REG. NO: A6-100103"]) {
			const r = await lookupMedicine(input, makeEnv());
			expect(r.status).toBe("match");
		}
	});

	it("returns not_found for an unknown number, still labelled as fixture", async () => {
		const r = await lookupMedicine("A6-999999", makeEnv());
		expect(r.status).toBe("not_found");
		if (r.status !== "not_found") return;
		expect(r.source.type).toBe("local_fixture");
		expect(r.source.isLiveOfficialResult).toBe(false);
	});

	it("does not treat a partial number as a match", async () => {
		const r = await lookupMedicine("A6-1001", makeEnv());
		expect(r.status).toBe("not_found");
	});

	it("returns invalid_input for nonsense", async () => {
		for (const input of ["", "hello", "???", "A6-"]) {
			const r = await lookupMedicine(input, makeEnv());
			expect(r.status).toBe("invalid_input");
		}
	});

	it("computes registrationExpired from the current date", async () => {
		vi.useFakeTimers();

		vi.setSystemTime(new Date("2026-10-31T12:00:00Z"));
		const before = await lookupMedicine("A6-100103", makeEnv());
		expect(before.status === "match" && before.record.registrationExpired).toBe(false);

		vi.setSystemTime(new Date("2030-01-01T12:00:00Z"));
		const after = await lookupMedicine("A6-100103", makeEnv());
		expect(after.status === "match" && after.record.registrationExpired).toBe(true);
	});
});

describe("lookupMedicine in live mode (mocked fetch)", () => {
	it("returns a match labelled as a live official result", async () => {
		const fetchMock = stubLiveResponse({
			draw: 1,
			recordsTotal: 8966,
			recordsFiltered: 1,
			data: [rec("A6-100103", "Hepatitis B Vaccine")],
		});

		const r = await lookupMedicine("a6-100103", makeEnv("live"));
		expect(r.status).toBe("match");
		if (r.status !== "match") return;

		expect(r.record.productName).toBe("Hepatitis B Vaccine");
		expect(r.record.applicant).toBe("Test Applicant Ltd");
		expect(r.source.type).toBe("greenbook_live");
		expect(r.source.isLiveOfficialResult).toBe(true);
		expect(r.source.fixtureCapturedAt).toBeNull();

		const calledUrl = String(fetchMock.mock.calls[0]![0]);
		expect(calledUrl).toContain("search%5Bvalue%5D=A6-100103");
	});

	it("picks the exact record when near-matches come back too", async () => {
		stubLiveResponse({
			recordsFiltered: 2,
			data: [rec("A6-1001039", "Other Product"), rec("A6-100103", "Right Product")],
		});
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status === "match" && r.record.productName).toBe("Right Product");
	});

	it("returns not_found when only near-matches come back", async () => {
		stubLiveResponse({ recordsFiltered: 1, data: [rec("A6-1001039", "Other Product")] });
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("not_found");
		if (r.status !== "not_found") return;
		expect(r.source.isLiveOfficialResult).toBe(true);
	});

	it("returns not_found when the registry has no records", async () => {
		stubLiveResponse({ recordsFiltered: 0, data: [] });
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("not_found");
	});

	it("returns source_unavailable on an HTTP error", async () => {
		stubLiveResponse({ message: "boom" }, 500);
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
		if (r.status !== "source_unavailable") return;
		expect(r.source.isLiveOfficialResult).toBe(false);
		expect(r.reason).toContain("500");
	});

	it("returns source_unavailable when the network fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
	});

	it("returns source_unavailable when the reply is not JSON", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>maintenance</html>", { status: 200 })));
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
	});

	it("returns source_unavailable when the JSON has an unexpected shape", async () => {
		stubLiveResponse({ error: "something else" });
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
	});

	it("does not claim not_found when more results exist than were returned", async () => {
		stubLiveResponse({ recordsFiltered: 120, data: [rec("A6-1001039")] });
		const r = await lookupMedicine("A6-100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
	});

	it("does not claim not_found from a full page with no recordsFiltered", async () => {
		const data = Array.from({ length: 50 }, (_, i) => rec(`A6-1001${String(i).padStart(3, "0")}`));
		stubLiveResponse({ data });
		const r = await lookupMedicine("A6-100", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
	});

	it("does not claim not_found for a number that lost its dash", async () => {
		stubLiveResponse({ recordsFiltered: 0, data: [] });
		const r = await lookupMedicine("A6100103", makeEnv("live"));
		expect(r.status).toBe("source_unavailable");
		if (r.status !== "source_unavailable") return;
		expect(r.source.isLiveOfficialResult).toBe(false);
	});

	it("returns source_unavailable on timeout", async () => {
		vi.useFakeTimers();
		vi.stubGlobal(
			"fetch",
			vi.fn().mockImplementation(
				(_url: string, init: { signal: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init.signal.addEventListener("abort", () =>
							reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						);
					}),
			),
		);

		const pending = lookupMedicine("A6-100103", makeEnv("live"));
		await vi.advanceTimersByTimeAsync(16_000);
		const r = await pending;
		expect(r.status).toBe("source_unavailable");
		if (r.status !== "source_unavailable") return;
		expect(r.reason).toContain("in time");
	});
});