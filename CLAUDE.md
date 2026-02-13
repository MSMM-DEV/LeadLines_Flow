# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LeadLines_Flow** is a single-page community outreach web application for Orleans Parish, New Orleans. It collects property and contact information from property owners and renters through a multi-step questionnaire, then presents a DocuSign embedded signing flow for authorization documents. The frontend lives in one self-contained HTML file (`index.html`); the backend is an Express server (`server.js`) that handles DocuSign JWT auth and envelope creation.

## Architecture

- **Single-file frontend**: All HTML, CSS, and React JSX in `index.html` — no build system, no bundler. Uses Babel Standalone for in-browser JSX transpilation.
- **CDN dependencies**: React 18, ReactDOM, Babel Standalone, qrcodejs, Leaflet, DocuSign Focused View SDK (`js-d.docusign.com/bundle.js`)
- **Express backend** (`server.js`): Serves static files and exposes DocuSign API endpoints. Uses JWT Grant auth with RSA keypair. Runs on port 3000.
- **Property data**: ~162K Orleans Parish parcels pre-loaded from gis.nola.gov ArcGIS into Supabase (`noleadnola_parcels` table). Frontend queries Supabase REST API directly using the anon key (public data, read-only via RLS).
- **Supabase project**: `clcufcjifbvpbtsczkmx.supabase.co`

## How to Run

Frontend only (no DocuSign signing):
```
python3 -m http.server 8000
```

Full app with DocuSign signing:
```
npm install
npm start          # Express on http://localhost:3000
```

Re-download parcel data from ArcGIS:
```
npm install
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run download-parcels
# Resume from a specific OBJECTID: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/download-parcels.js 102150000
```

Create/reset Supabase table:
```
npm run create-table   # requires DATABASE_URL in .env
```

## Key Components (all in `index.html`)

- `App` — Root component; hash-based routing (`#questionnaire` → Questionnaire, else → HomePage)
- `Questionnaire` — Multi-step form: address → filler info → ownership → property records/DocuSign signing → contact/submit. Step count changes based on ownership (owner: 5 steps, renter: 4 steps).
- `AddressInput` — Autocomplete that queries Supabase with ILIKE on `site_address`, debounced
- `PropertyMap` — Leaflet map rendering parcel polygon from pre-computed `polygon_coords`
- `ContactForm` — Reusable contact info form (first/last name, email, phone)

## Backend API Endpoints (`server.js`)

- `GET /api/docusign/config` — Returns `{ configured, integrationKey }` for Focused View SDK init
- `POST /api/docusign/create-envelope` — Creates DocuSign envelope from template, returns embedded signing URL. Body: `{ signerEmail, signerName, propertyAddress, parcelId?, ownerName? }`
- `GET /api/docusign/callback` — Post-signing redirect; posts message to parent window

## Data Flow

1. User enters address → `AddressInput` queries Supabase for autocomplete suggestions
2. `lookupProperty()` fetches full parcel record from Supabase → displays owner info, assessed values, map
3. `normalizeAddressForQuery()` strips city/state/zip and converts suffixes (STREET→ST, AVENUE→AVE, etc.)
4. `validateOrleansAddress()` checks against hardcoded `ORLEANS_ZIPS` Set and keyword matching
5. For owners: frontend calls `/api/docusign/create-envelope` → server creates JWT, gets access token, creates envelope from template → returns signing URL → DocuSign Focused View renders inline

## Environment Variables (`.env`)

Required for parcel download and DB operations:
- `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_KEY`, `DATABASE_URL`

Required for DocuSign (see `docusign-setup.md` for full setup):
- `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, `DOCUSIGN_ACCOUNT_ID`, `DOCUSIGN_TEMPLATE_ID`
- `DOCUSIGN_PRIVATE_KEY_PATH` (default: `config/docusign-private.key`)

## Important Notes

- The Supabase anon key is hardcoded in `index.html` — this is intentional (read-only access to public government data via RLS policy)
- Form submission currently logs to console only (`console.log`) — no backend persistence yet
- DocuSign uses demo/sandbox environment (`account-d.docusign.com`, `demo.docusign.net`). See `docusign-setup.md` "Production Notes" for go-live changes.
- The DocuSign template must have a recipient role named exactly `signer` and uses `clientUserId: '1000'` for embedded signing
- The ArcGIS server at gis.nola.gov has SSL cert issues (requires `NODE_TLS_REJECT_UNAUTHORIZED=0`) and is very slow for bulk downloads. The download script uses OBJECTID range queries (not offset pagination) for speed.
- OBJECTID range: 102,079,250 — 102,241,234
