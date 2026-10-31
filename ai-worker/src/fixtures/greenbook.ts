// LOCAL FIXTURE: a sample response captured from the NAFDAC Greenbook search for "A6-100103".
// This is demo data. It must never be presented as a live official result.

export const FIXTURE_CAPTURED_AT = "2026-10-31";

export const GREENBOOK_FIXTURE_RECORDS: Record<string, unknown>[] = [
	{
		product_id: 7078,
		ingredient_id: 924,
		manufacturer_id: 749,
		product_name: "Recombinant Hepatitis B Vaccine 0.5 mL (Pediatric)**",
		form_id: "90",
		strength: "10 mcg/0.5 mL",
		NAFDAC: "A6-100103",
		product_category_id: 2,
		marketing_category_id: 1,
		applicant_id: 1225,
		approval_date: "2023-06-04",
		expiry_date: "2028-05-30",
		route_id: 9,
		smpc: "https://admin.greenbook.nafdac.gov.ng/uploadImage/smpc_files/2025/01/28/20250128c3c3387f-30af-5554-8519-aef1d00ea271.pdf",
		country_id: null,
		product_description: "Suspension for injection.\r\nWhite suspension, packaged in prefill injection device",
		pack_size: "0.5 mL x 10&#039;s (in Pre-filled syringes) + 1 sterile needle (25G x 5/8&#039;)",
		biosimilar: null,
		atc: "J07BC01",
		created_at: "2024-01-17T01:01:55.000000Z",
		updated_at: "2025-06-01T00:52:51.000000Z",
		deleted_at: null,
		status: "Active",
		composition:
			"Each 0.5 mL dose contains: Hepatitis B surface antigen 10 mcg adsorbed onto Aluminum Hydroxide 0.025 mg, Thimerosal 0.01% w/v (as preservative)",
		ingredient: {
			ingredient_id: 924,
			ingredient_name: "Hepatitis B vaccine",
			synonym: "",
		},
		form: { id: 90, name: "Suspension for injection" },
		applicant: { id: 1225, name: "Biovaccines Nigeria Ltd", address: null },
		route: { id: 9, name: "Intramuscular" },
		product_category: { id: 2, name: "Vaccines and Biologics" },
		category_name: "Vaccines and Biologics",
		ingredient_name: "Hepatitis B vaccine",
		synonym: "",
		form_name: "Suspension for injection",
		applicant_name: "Biovaccines Nigeria Ltd",
		route_name: "Intramuscular",
		DT_RowIndex: 1,
	},
];