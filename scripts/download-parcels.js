#!/usr/bin/env node

/**
 * Bulk-download all Orleans Parish parcels from ArcGIS and upsert into Supabase.
 *
 * Usage: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/download-parcels.js [START_ID] [CONCURRENCY]
 *
 * Pass START_ID to resume from a specific OBJECTID (e.g., after a crash).
 * Pass CONCURRENCY to control parallel ArcGIS requests (default: 5, max: 10).
 *
 * Uses OBJECTID range queries instead of offset pagination — much faster
 * because ArcGIS can use the index directly without sorting.
 *
 * OBJECTID range: 102,079,250 — 102,241,234 (sequential, ~162K parcels)
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const ARCGIS_BASE = 'https://gis.nola.gov/arcgis/rest/services/GovernmentServices/LandBaseServices/MapServer/0/query';
const OUT_FIELDS = 'OBJECTID,SITEADDRESS,OWNERNME1,OWNERNME2,PARCELID,CLASSDSCRP,PRPRTYDSCRP,RESYRBLT,RESFLRAREA,ASS_SQFT,ASS_DIMS,LNDVALUE,CNTASSDVAL,CNTTXBLVAL,TAXBILLID,BLOCK,LOT';

// OBJECTID range (from exploration of the dataset)
const DEFAULT_MIN_ID = 102079250;
const MAX_ID = 102241235; // exclusive upper bound (max found + 1)
const RANGE_STEP = 2500; // ArcGIS maxRecordCount is 2500 — max out each request
const UPSERT_BATCH = 500; // Supabase upsert batch size
const FETCH_TIMEOUT = 120000;
const MAX_RETRIES = 5;
const UPSERT_RETRIES = 3;

// Allow resuming from a specific OBJECTID
const START_ID = process.argv[2] ? parseInt(process.argv[2], 10) : DEFAULT_MIN_ID;

/**
 * Fetch with timeout and retry (with exponential backoff)
 */
async function fetchWithRetry(url, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return await resp.json();
    } catch (err) {
      if (attempt === retries) throw err;
      // Exponential backoff: 3s, 9s, 27s, 81s
      const wait = Math.min(3000 * Math.pow(3, attempt - 1), 90000);
      console.log(`    [retry ${attempt}/${retries}] ${err.message} — waiting ${(wait/1000).toFixed(0)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

/**
 * Fetch a range of records by OBJECTID
 */
async function fetchRange(startId, endId) {
  const params = new URLSearchParams({
    where: `OBJECTID >= ${startId} AND OBJECTID < ${endId}`,
    outFields: OUT_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'json',
  });
  const url = `${ARCGIS_BASE}?${params}`;
  const data = await fetchWithRetry(url);
  if (data.error) throw new Error(`ArcGIS error for range ${startId}-${endId}: ${JSON.stringify(data.error)}`);
  return data;
}

/**
 * Transform an ArcGIS feature into a Supabase row
 */
function transformFeature(feature) {
  const a = feature.attributes;
  let centroid_lat = null, centroid_lng = null, polygon_coords = null;

  if (feature.geometry && feature.geometry.rings && feature.geometry.rings.length > 0) {
    const ring = feature.geometry.rings[0];
    if (ring.length > 0) {
      const sumX = ring.reduce((s, pt) => s + pt[0], 0);
      const sumY = ring.reduce((s, pt) => s + pt[1], 0);
      centroid_lng = sumX / ring.length;
      centroid_lat = sumY / ring.length;
      polygon_coords = ring.map(pt => [pt[1], pt[0]]);
    }
  }

  return {
    id: a.OBJECTID,
    site_address: a.SITEADDRESS || null,
    owner_name1: a.OWNERNME1 || null,
    owner_name2: a.OWNERNME2 || null,
    parcel_id: a.PARCELID || null,
    property_type: a.CLASSDSCRP || null,
    property_desc: a.PRPRTYDSCRP || null,
    year_built: a.RESYRBLT || null,
    living_area: a.RESFLRAREA || null,
    lot_sqft: a.ASS_SQFT != null ? String(a.ASS_SQFT) : null,
    lot_dims: a.ASS_DIMS || null,
    land_value: a.LNDVALUE || null,
    assessed_value: a.CNTASSDVAL || null,
    taxable_value: a.CNTTXBLVAL || null,
    tax_bill_id: a.TAXBILLID || null,
    block: a.BLOCK || null,
    lot: a.LOT || null,
    centroid_lat,
    centroid_lng,
    polygon_coords,
  };
}

/**
 * Upsert rows into Supabase with retry on transient errors
 */
async function upsertRows(rows) {
  let upserted = 0;
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const batch = rows.slice(i, i + UPSERT_BATCH);
    for (let attempt = 1; attempt <= UPSERT_RETRIES; attempt++) {
      const { error } = await supabase
        .from('noleadnola_parcels')
        .upsert(batch, { onConflict: 'id' });
      if (!error) {
        upserted += batch.length;
        break;
      }
      if (attempt === UPSERT_RETRIES) {
        console.error(`  Upsert failed after ${UPSERT_RETRIES} retries:`, error.message.slice(0, 200));
        throw error;
      }
      const wait = attempt * 10000;
      console.log(`    Upsert retry ${attempt}/${UPSERT_RETRIES} in ${wait/1000}s: ${error.message.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  return upserted;
}

/**
 * Pipeline: fetch next chunk from ArcGIS while upserting current chunk to Supabase.
 * ArcGIS only handles 1 request at a time (~40s each regardless of batch size),
 * so we overlap the Supabase write with the next ArcGIS fetch.
 */
async function runPipeline(chunks) {
  let totalFetched = 0;
  let totalUpserted = 0;
  const failedChunks = [];
  const startTime = Date.now();
  const totalChunks = chunks.length;

  let pendingUpsert = null; // Promise for the in-flight Supabase upsert

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const eta = i > 0 ? Math.round(((Date.now() - startTime) / i) * (totalChunks - i) / 1000) : '?';
    console.log(`Chunk ${i + 1}/${totalChunks} [${chunk.start}..${chunk.end}] — ${totalFetched} fetched — ${elapsed}s elapsed — ~${eta}s remaining`);

    // Start ArcGIS fetch
    let data;
    try {
      data = await fetchRange(chunk.start, chunk.end);
    } catch (err) {
      console.error(`  FAILED fetch ${chunk.start}-${chunk.end}: ${err.message.slice(0, 120)}`);
      failedChunks.push(chunk);
      continue;
    }

    // Wait for previous upsert to finish before starting next one
    if (pendingUpsert) {
      try {
        totalUpserted += await pendingUpsert;
      } catch (err) {
        console.error(`  FAILED upsert (previous batch): ${err.message.slice(0, 120)}`);
      }
      pendingUpsert = null;
    }

    if (!data.features || data.features.length === 0) continue;

    totalFetched += data.features.length;
    console.log(`  Fetched ${data.features.length} records`);

    const rows = data.features.map(transformFeature);
    // Fire off upsert in background — it runs while next ArcGIS fetch starts
    pendingUpsert = upsertRows(rows).catch(err => {
      console.error(`  FAILED upsert ${chunk.start}-${chunk.end}: ${err.message.slice(0, 120)}`);
      failedChunks.push(chunk);
      return 0;
    });
  }

  // Wait for final upsert
  if (pendingUpsert) {
    try {
      totalUpserted += await pendingUpsert;
    } catch (err) {
      console.error(`  FAILED upsert (final batch): ${err.message.slice(0, 120)}`);
    }
  }

  return { totalFetched, totalUpserted, failedChunks, startTime };
}

async function main() {
  const totalRange = MAX_ID - START_ID;
  const totalChunks = Math.ceil(totalRange / RANGE_STEP);

  console.log('=== Orleans Parish Parcel Download ===');
  console.log(`OBJECTID range: ${START_ID} — ${MAX_ID}`);
  if (START_ID !== DEFAULT_MIN_ID) console.log(`(Resuming from ${START_ID})`);
  console.log(`Range step: ${RANGE_STEP} (ArcGIS max: 2500) | Chunks: ${totalChunks}`);
  console.log(`Estimated time: ~${Math.ceil(totalChunks * 42 / 60)} minutes`);
  console.log(`Supabase: ${SUPABASE_URL}\n`);

  // Build all chunk ranges
  const chunks = [];
  for (let start = START_ID; start < MAX_ID; start += RANGE_STEP) {
    chunks.push({ start, end: Math.min(start + RANGE_STEP, MAX_ID) });
  }

  // Pipeline run: sequential ArcGIS fetches, overlapped Supabase upserts
  let { totalFetched, totalUpserted, failedChunks, startTime } = await runPipeline(chunks);

  // Retry failed chunks with longer delays
  if (failedChunks.length > 0) {
    console.log(`\nRetrying ${failedChunks.length} failed chunks (30s delay between each)...`);
    const stillFailed = [];
    for (const chunk of failedChunks) {
      console.log(`  Retrying ${chunk.start}-${chunk.end}...`);
      await new Promise(r => setTimeout(r, 30000));
      try {
        const data = await fetchRange(chunk.start, chunk.end);
        if (data.features && data.features.length > 0) {
          totalFetched += data.features.length;
          const rows = data.features.map(transformFeature);
          totalUpserted += await upsertRows(rows);
          console.log(`  OK: ${data.features.length} records`);
        }
      } catch (err) {
        console.error(`  Still failed ${chunk.start}-${chunk.end}: ${err.message.slice(0, 100)}`);
        stillFailed.push(chunk);
      }
    }
    failedChunks = stillFailed;
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n=== Download Complete ===');
  console.log(`Total fetched: ${totalFetched}`);
  console.log(`Total upserted: ${totalUpserted}`);
  console.log(`Time: ${totalTime}s`);
  if (failedChunks.length > 0) {
    console.log(`\nFailed chunks (${failedChunks.length}):`);
    for (const c of failedChunks) console.log(`  ${c.start}-${c.end}`);
    console.log(`\nRe-run with: NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/download-parcels.js ${failedChunks[0].start}`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
