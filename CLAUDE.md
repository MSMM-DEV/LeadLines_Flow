# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LeadLines_Flow** is a single-page community outreach web application for Orleans Parish, New Orleans. It collects property and contact information from property owners and renters through a multi-step questionnaire, then presents a DocuSign embedded signing flow for authorization documents. The frontend lives in one self-contained HTML file (`index.html`); the backend is an Express server (`server.js`) that handles DocuSign JWT auth, envelope creation, and submission persistence.

## How to Run

Frontend only (no DocuSign signing):
```
python3 -m http.server 8000
```

Full app with DocuSign signing + submission persistence:
```
npm install
npm start          # Express on http://localhost:3000
```

Re-download parcel data from ArcGIS:
```
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run download-parcels
# Resume from a specific OBJECTID:
NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/download-parcels.js 102150000
```

Database table setup:
```
npm run create-table              # parcels table (requires DATABASE_URL in .env)
npm run create-submissions-table  # submissions table
```

## Architecture

- **Single-file frontend**: All HTML, CSS, and React JSX live in `index.html` — no build system, no bundler. Uses Babel Standalone for in-browser JSX transpilation. CDN dependencies: React 18, ReactDOM, Babel Standalone, qrcodejs, Leaflet.
- **Express backend** (`server.js`): Serves static files and exposes API endpoints. Uses JWT Grant auth with RSA keypair for DocuSign. Exported as `module.exports = app` for Vercel serverless compatibility.
- **Vercel deployment**: `api/index.js` re-exports the Express app as a serverless function. `vercel.json` rewrites `/api/*` to this function. The private key can be passed via `DOCUSIGN_PRIVATE_KEY` env var (no file needed).
- **Property data**: ~162K Orleans Parish parcels in Supabase (`noleadnola_parcels` table), pre-loaded from gis.nola.gov ArcGIS. Frontend queries Supabase REST API directly using the anon key (public data, read-only via RLS).
- **Submissions**: Saved to Supabase `noleadnola_submissions` table via the backend (`POST /api/submissions`). Schema in `scripts/create-submissions-table.sql`.

## Questionnaire Flow (4 steps)

The `Questionnaire` component in `index.html` walks through 4 steps:
1. **Address** — `AddressInput` autocomplete queries Supabase with ILIKE on `site_address`; `validateOrleansAddress()` checks against hardcoded `ORLEANS_ZIPS` Set. Background-prefetches property data via `lookupProperty()`.
2. **Filler Info** — `ContactForm` collects the form-filler's name/email/phone.
3. **Ownership** — Owner or renter selection. If owner, awaits the prefetched property lookup.
4. **Property Records + Contact** (owner path) — Shows assessor data, `PropertyMap` with Leaflet polygon, name-match check, signing authority question, and contact form. Submits to `/api/submissions`, then if signing authority = yes, creates DocuSign envelope and redirects to DocuSign for signing. OR **Landlord Contact** (renter path) — Collects landlord info and submits.

After DocuSign signing, the callback redirects to `/#signing-{event}` which the `App` component parses to show success/error.

## Backend API Endpoints (`server.js`)

- `GET /api/docusign/config` — Returns `{ configured, integrationKey }` for frontend
- `POST /api/docusign/create-envelope` — Creates envelope from template, returns signing URL. Body: `{ signerEmail, signerName, propertyAddress, parcelId?, ownerName?, submissionId? }`
- `GET /api/docusign/callback` — Post-signing redirect; updates submission status in Supabase, then redirects to `/#signing-{event}`
- `POST /api/submissions` — Persists questionnaire data to `noleadnola_submissions`. Returns `{ id }`
- `PATCH /api/submissions/:id/docusign` — Updates DocuSign envelope ID/status on an existing submission

## Key Helper Functions (`index.html`)

- `normalizeAddressForQuery()` — Strips city/state/zip and converts suffixes (STREET→ST, AVENUE→AVE, etc.)
- `lookupProperty()` — Fetches full parcel record from Supabase, returns owner info, assessed values, coordinates, polygon
- `formatOwnerRows()` — Formats assessor data into label/value pairs for display
- `validateOrleansAddress()` — Validates against `ORLEANS_ZIPS` Set and keyword matching

## Environment Variables (`.env`)

Required for Supabase operations:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `DATABASE_URL`

Required for DocuSign (see `docusign-setup.md`):
- `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_TEMPLATE_ID`
- `DOCUSIGN_PRIVATE_KEY_PATH` (local dev, default: `config/docusign-private.key`) or `DOCUSIGN_PRIVATE_KEY` (Vercel, raw PEM string)

## Important Notes

- The Supabase anon key is hardcoded in `index.html` — intentional (read-only access to public government data via RLS)
- DocuSign uses demo/sandbox environment (`account-d.docusign.com`, `demo.docusign.net`). See `docusign-setup.md` "Production Notes" for go-live changes.
- The DocuSign template must have a recipient role named exactly `signer` and uses `clientUserId: '1000'` for embedded signing
- The ArcGIS server at gis.nola.gov has SSL cert issues (requires `NODE_TLS_REJECT_UNAUTHORIZED=0`) and is very slow. The download script uses OBJECTID range queries (not offset pagination). OBJECTID range: 102,079,250 — 102,241,234.
- `UserGate/` is a separate project (Python/FastAPI + React/Vite) with its own git repo — not part of this app
