# CounterfeitIQ: AI extraction and NAFDAC reference lookup

Cloudflare Worker (TypeScript) with two independent modules for the verification orchestrator:

- `extractProduct(image)` reads a product-packaging photo with Gemma and returns structured data.
- `lookupMedicine(nafdacNumber)` looks up a registration number in the NAFDAC Greenbook (or a labelled local fixture).

A matching Greenbook record does **not** prove a physical package is genuine. Neither module makes any authenticity claim.

## Setup

```
npm install
npx wrangler login
npm run dev          # http://127.0.0.1:8787
npx vitest run       # 54 tests, no AI quota needed (needs wrangler login: the AI binding is remote)
npm run typecheck    # checks src and test
npm run deploy       # not yet deployed
```

Requires Node.js 26 (LTS) and a Cloudflare account with Workers AI.

## Configuration

Set in `wrangler.jsonc` under `vars`. There are no secrets.

| Name | Purpose | Default |
|---|---|---|
| `AI` (binding) | Workers AI | n/a |
| `GEMMA_MODEL` | Model ID | `@cf/google/gemma-4-26b-a4b-it` |
| `MAX_IMAGE_BYTES` | Upload limit | `5242880` (5 MB) |
| `ALLOWED_ORIGINS` | Comma-separated CORS allowlist | `http://localhost:3000,http://localhost:5173` |
| `GREENBOOK_MODE` | `fixture` or `live` | `fixture` |
| `ENABLE_DEV_ROUTES` | Enables `/api/dev/*` test routes | `false` |

To use the test routes locally, create `.dev.vars` containing `ENABLE_DEV_ROUTES=true` (it is git-ignored).

## Using the modules

```ts
import { createExtractProduct } from "./extract";
import { createLookupMedicine } from "./lookup";

// inside a Worker, where env is the Worker's Env
const extractProduct = createExtractProduct(env);   // (image: File | Blob) => Promise<ExtractedProduct>
const lookupMedicine = createLookupMedicine(env);   // (nafdacNumber: string) => Promise<ReferenceLookupResult>
```

The plain functions `extractProduct(image, env)` and `lookupMedicine(number, env)` are also exported. Types are in `src/types.ts`.

### extractProduct

- Accepts JPEG, PNG or WebP (checked from the file's real bytes) up to `MAX_IMAGE_BYTES`.
- Returns `ExtractedProduct`: every field is a string (or `string[]` for `ingredients`) or `null` when not clearly readable.
- Throws `ExtractionError` with a `code`: `empty_image`, `unsupported_type`, `too_large`, `timeout` (30 s), `rate_limited`, `model_error`, `malformed_output`.
- The NAFDAC number goes through the same normaliser as lookup (uppercase, plain hyphens, label prefix removed, one space read as a lost hyphen); uncertain values become `null`.
- `manufacturingDate` and `expiryDate` are kept as printed. `manufacturingMonth` and `expiryMonth` are `YYYY-MM`, or `null` if the date is missing or ambiguous (`12/06/2026` could be either order). Compare these, not the printed text.

### lookupMedicine

Never throws. Returns `ReferenceLookupResult`, with `status` one of:

- `match`: exact registration-number match; `record` holds the normalised data.
- `not_found`: no exact match.
- `source_unavailable`: the source could not be used or checked completely; `reason` explains. This includes a number with no hyphen that found nothing, because Greenbook search cannot match it.
- `invalid_input`: not a plausible NAFDAC number (no `source`, nothing was looked up).

Every result except `invalid_input` carries `source`:

- `source.type` is `"local_fixture"` or `"greenbook_live"`.
- `source.isLiveOfficialResult` is `true` **only** for an answer received from the live Greenbook. Use this field to tell real reference data from demo data.
- `source.retrievedAt` is the time of the lookup; `source.fixtureCapturedAt` is set only for fixtures.

## Sample responses

Extraction (`POST /api/dev/extract`, clear photo of a Maldox box):

```json
{
  "ok": true,
  "data": {
    "productName": "Maldox",
    "brand": "Maldox",
    "category": null,
    "manufacturer": "mzor",
    "nafdacNumber": "04-2911",
    "ingredients": ["Sulfadoxine", "Pyrimethamine"],
    "strength": "500/25mg",
    "batchNumber": null,
    "manufacturingDate": null,
    "expiryDate": null,
    "manufacturingMonth": null,
    "expiryMonth": null
  }
}
```

Extraction, photo with no readable NAFDAC number:

```json
{
  "ok": true,
  "data": {
    "productName": "PENTAZOCINE INJECTION 30 mg USP",
    "brand": "FORTWIN",
    "category": null,
    "manufacturer": "Sun Pharmaceutical Ind. Ltd.",
    "nafdacNumber": null,
    "ingredients": null,
    "strength": "30 mg",
    "batchNumber": null,
    "manufacturingDate": null,
    "expiryDate": null,
    "manufacturingMonth": null,
    "expiryMonth": null
  }
}
```

Extraction errors: `{"ok":false,"error":{"code":"too_large","message":"..."}}` (HTTP 413), `unsupported_type` (415), `rate_limited` (429), `timeout` (504), `model_error` / `malformed_output` (502).

Lookup match (`GET /api/dev/lookup?nafdac=A6-100103`, fixture mode; `retrievedAt` varies):

```json
{
  "status": "match",
  "query": "A6-100103",
  "record": {
    "nafdacNumber": "A6-100103",
    "productName": "Recombinant Hepatitis B Vaccine 0.5 mL (Pediatric)",
    "activeIngredient": "Hepatitis B vaccine",
    "composition": "Each 0.5 mL dose contains: Hepatitis B surface antigen 10 mcg adsorbed onto Aluminum Hydroxide 0.025 mg, Thimerosal 0.01% w/v (as preservative)",
    "strength": "10 mcg/0.5 mL",
    "dosageForm": "Suspension for injection",
    "route": "Intramuscular",
    "category": "Vaccines and Biologics",
    "applicant": "Biovaccines Nigeria Ltd",
    "registrationStatus": "Active",
    "approvalDate": "2023-06-04",
    "registrationExpiry": "2028-05-30",
    "registrationExpired": false,
    "packSize": "0.5 mL x 10's (in Pre-filled syringes) + 1 sterile needle (25G x 5/8')",
    "atcCode": "J07BC01",
    "productInfoUrl": "https://admin.greenbook.nafdac.gov.ng/uploadImage/smpc_files/2025/01/28/20250128c3c3387f-30af-5554-8519-aef1d00ea271.pdf"
  },
  "source": {
    "name": "NAFDAC Greenbook",
    "type": "local_fixture",
    "isLiveOfficialResult": false,
    "url": "https://greenbook.nafdac.gov.ng/",
    "retrievedAt": "2026-10-31T01:39:45.512Z",
    "fixtureCapturedAt": "2026-10-31"
  }
}
```

Lookup not found (fixture mode):

```json
{
  "status": "not_found",
  "query": "A6-999999",
  "source": {
    "name": "NAFDAC Greenbook",
    "type": "local_fixture",
    "isLiveOfficialResult": false,
    "url": "https://greenbook.nafdac.gov.ng/",
    "retrievedAt": "2026-10-31T01:37:33.803Z",
    "fixtureCapturedAt": "2026-10-31"
  }
}
```

Invalid input:

```json
{ "status": "invalid_input", "query": "hello", "reason": "Not a plausible NAFDAC registration number" }
```

## Greenbook notes

- The site is not a documented public API. The adapter follows the DataTables search request seen in the browser (global search, `search[value]=<number>`).
- **Live mode is off.** Automated access has not been confirmed as permitted. Do not set `GREENBOOK_MODE=live` until it is. The live path is implemented and tested only against mocked responses, and the real site sets session cookies that may be required.
- Greenbook search matches any column and returns partial matches, so the adapter requires an exact match on the registration number.
- Greenbook exposes an `applicant`, not a manufacturer name. `record.applicant` must not be treated as the manufacturer when comparing with the package.
- Fixture data is a single record (`A6-100103`, captured 2026-10-31). A `not_found` from the fixture is not an official negative.

## Known limitations

- One product per image: if several are visible, the model describes the most prominent one. An all-`null` result means nothing was readable.
- Logos and stylised text are read less reliably (a box showing "Emzor" came back as "mzor"). Treat `manufacturer` and `brand` as lower confidence than `nafdacNumber`.
- Text may be wrong even when the model is confident; the orchestrator should compare, not trust.
- Gemma 4 thinking mode is disabled (`chat_template_kwargs.enable_thinking = false`); with it on, the model used its whole token budget on reasoning. A call costs about 6 Neurons (free allowance: 10,000 per day).

## Tests

`npx vitest run` runs 54 tests covering fixture and mocked-live lookup (exact match, near-matches, not found, unavailable source, timeout, bad JSON, expiry), extraction parsing and error handling (timeout, rate limit, malformed or cut-off output, oversized and non-image files), CORS and routing. Live-photo checks (clear, blurry, no NAFDAC number, non-medicine, oversized, non-image) were run manually through `/api/dev/extract`.