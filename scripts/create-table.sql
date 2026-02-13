-- Enable pg_trgm extension for fuzzy text search (run once)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Create parcels table
CREATE TABLE IF NOT EXISTS noleadnola_parcels (
  id BIGINT PRIMARY KEY,              -- OBJECTID from ArcGIS
  site_address TEXT,                    -- SITEADDRESS (main lookup field)
  owner_name1 TEXT,                     -- OWNERNME1
  owner_name2 TEXT,                     -- OWNERNME2
  parcel_id TEXT,                       -- PARCELID
  property_type TEXT,                   -- CLASSDSCRP
  property_desc TEXT,                   -- PRPRTYDSCRP
  year_built DOUBLE PRECISION,          -- RESYRBLT
  living_area DOUBLE PRECISION,         -- RESFLRAREA
  lot_sqft TEXT,                        -- ASS_SQFT
  lot_dims TEXT,                        -- ASS_DIMS
  land_value DOUBLE PRECISION,          -- LNDVALUE
  assessed_value DOUBLE PRECISION,      -- CNTASSDVAL
  taxable_value DOUBLE PRECISION,       -- CNTTXBLVAL
  tax_bill_id TEXT,                     -- TAXBILLID
  block TEXT,                           -- BLOCK (square)
  lot TEXT,                             -- LOT
  centroid_lat DOUBLE PRECISION,        -- Pre-computed from geometry
  centroid_lng DOUBLE PRECISION,        -- Pre-computed from geometry
  polygon_coords JSONB,                 -- [[lat,lng],...] for Leaflet
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Index for address lookups (trigram for fast ILIKE)
CREATE INDEX IF NOT EXISTS idx_noleadnola_parcels_address
  ON noleadnola_parcels USING GIN (upper(site_address) gin_trgm_ops);

-- Fallback B-tree index on upper(site_address)
CREATE INDEX IF NOT EXISTS idx_noleadnola_parcels_address_upper
  ON noleadnola_parcels (upper(site_address));

-- Allow public read access via anon key
ALTER TABLE noleadnola_parcels ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'noleadnola_parcels' AND policyname = 'Public read access'
  ) THEN
    CREATE POLICY "Public read access" ON noleadnola_parcels FOR SELECT USING (true);
  END IF;
END
$$;
