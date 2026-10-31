export interface ExtractedProduct {
	productName: string | null;
	brand: string | null;
	category: string | null;
	manufacturer: string | null;
	nafdacNumber: string | null;
	ingredients: string[] | null;
	strength: string | null;
	batchNumber: string | null;
	/** The date as printed on the package. Format varies; use manufacturingMonth to compare. */
	manufacturingDate: string | null;
	/** The date as printed on the package. Format varies; use expiryMonth to compare. */
	expiryDate: string | null;
	/** YYYY-MM parsed from manufacturingDate; null if missing or ambiguous. */
	manufacturingMonth: string | null;
	/** YYYY-MM parsed from expiryDate; null if missing or ambiguous. */
	expiryMonth: string | null;
}

export type ExtractionErrorCode =
	| "empty_image"
	| "unsupported_type"
	| "too_large"
	| "timeout"
	| "rate_limited"
	| "model_error"
	| "malformed_output";

export class ExtractionError extends Error {
	code: ExtractionErrorCode;

	constructor(code: ExtractionErrorCode, message: string) {
		super(message);
		this.name = "ExtractionError";
		this.code = code;
	}
}

export type ReferenceSourceType = "greenbook_live" | "local_fixture";

export interface ReferenceSource {
	name: "NAFDAC Greenbook";
	type: ReferenceSourceType;
	/** True only when a real answer came from a live request to the official Greenbook. */
	isLiveOfficialResult: boolean;
	url: string;
	/** ISO time when this lookup was made. */
	retrievedAt: string;
	/** Only for local fixtures: the date the sample data was captured from the real site. */
	fixtureCapturedAt: string | null;
}

export interface MedicineRecord {
	nafdacNumber: string;
	productName: string | null;
	activeIngredient: string | null;
	composition: string | null;
	strength: string | null;
	dosageForm: string | null;
	route: string | null;
	category: string | null;
	/** The registrant named by Greenbook. This is NOT necessarily the manufacturer. */
	applicant: string | null;
	registrationStatus: string | null;
	approvalDate: string | null;
	registrationExpiry: string | null;
	/** Computed from registrationExpiry at lookup time; null if the date is missing or unreadable. */
	registrationExpired: boolean | null;
	packSize: string | null;
	atcCode: string | null;
	productInfoUrl: string | null;
}

export type ReferenceLookupResult =
	| { status: "match"; query: string; record: MedicineRecord; source: ReferenceSource }
	| { status: "not_found"; query: string; source: ReferenceSource }
	| { status: "source_unavailable"; query: string; reason: string; source: ReferenceSource }
	| { status: "invalid_input"; query: string; reason: string };