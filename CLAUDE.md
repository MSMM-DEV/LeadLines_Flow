# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LeadLines_Flow** is a single-page community outreach web application for Orleans Parish, New Orleans. It collects property and contact information from property owners and renters through a multi-step questionnaire. The entire app lives in one self-contained HTML file (`help-us-help-you.html`).

## Architecture

- **Single-file app**: All HTML, CSS, and React JSX live in `help-us-help-you.html` — no build system, no bundler, no package.json
- **Runtime dependencies** (loaded via CDN): React 18, ReactDOM, Babel Standalone (for in-browser JSX transpilation), qrcodejs
- **Orleans Parish Assessor integration**: The `lookupProperty()` function queries the public ArcGIS REST API at `gis.nola.gov` (same data that powers beacon.schneidercorp.com). Uses JSONP to bypass CORS — no API key, no backend needed. Returns owner name, parcel ID, assessed values, tax info, etc. in <1 second.

## Key Components (all in `help-us-help-you.html`)

- `App` — Router-like root component; switches between `HomePage` and `Questionnaire` via hash routing (`#questionnaire`)
- `HomePage` — Landing page with QR code generation and CTA button
- `Questionnaire` — Multi-step form (address → ownership → property records/contact info → submit)
- `ContactForm` — Reusable contact info form (first/last name, email, phone)
- `jsonpFetch(url)` — JSONP helper for cross-origin requests to ArcGIS
- `normalizeAddressForQuery(addr)` — Strips city/state/zip and uppercases for ArcGIS SITEADDRESS queries
- `lookupProperty(address)` — Async function that queries gis.nola.gov ArcGIS API for Orleans Parish Assessor data
- `validateOrleansAddress(addr)` — Validates that an address is within Orleans Parish using zip codes and keyword matching

## How to Run

Open `help-us-help-you.html` directly in a browser, or serve it with any static file server:
```
python3 -m http.server 8000
# then visit http://localhost:8000/help-us-help-you.html
```

## Important Notes

- Property lookup uses the public ArcGIS REST API at `gis.nola.gov/arcgis/rest/services/GovernmentServices/LandBaseServices/MapServer/0/query` — no API key needed
- JSONP is used instead of fetch to bypass CORS restrictions from the browser
- The ArcGIS `SITEADDRESS` field requires uppercase addresses without city/state/zip
- Orleans Parish zip code validation uses a hardcoded `ORLEANS_ZIPS` Set
- Form submission currently logs to console only (`console.log`) — no backend persistence
- The note box links to beacon.schneidercorp.com for users who want full assessor details
