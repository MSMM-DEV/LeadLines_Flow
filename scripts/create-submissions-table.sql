-- Create submissions table for questionnaire responses
CREATE TABLE IF NOT EXISTS noleadnola_submissions (
  id              BIGSERIAL PRIMARY KEY,

  -- Step 1: Address
  address         TEXT NOT NULL,

  -- Step 2: Filler info (person filling out the form)
  filler_first_name   TEXT,
  filler_last_name    TEXT,
  filler_email        TEXT,
  filler_phone        TEXT,

  -- Step 3: Ownership
  ownership           TEXT CHECK (ownership IN ('own', 'rent')),

  -- Step 4 (owners): Property records match
  property_records_match  BOOLEAN,

  -- Step 4 (owners): Signing authority
  signing_authority       TEXT,

  -- Step 4 (owners): Assessor data from public records
  assessor_owner_name     TEXT,
  parcel_id               TEXT,
  legal_description       TEXT,
  property_type           TEXT,
  year_built              DOUBLE PRECISION,
  living_area             DOUBLE PRECISION,
  lot_sqft                TEXT,
  lot_dimensions          TEXT,
  land_value              DOUBLE PRECISION,
  assessed_value          DOUBLE PRECISION,
  taxable_value           DOUBLE PRECISION,
  tax_bill_id             TEXT,
  square                  TEXT,
  lot                     TEXT,

  -- Contact info
  contact_first_name      TEXT,
  contact_last_name       TEXT,
  contact_email           TEXT,
  contact_phone           TEXT,
  contact_role            TEXT,

  -- DocuSign status
  docusign_envelope_id    TEXT,
  docusign_status         TEXT,

  -- Timestamps
  submitted_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at              TIMESTAMPTZ DEFAULT NOW()
);

-- RLS: service_role can read/write, anon can read
ALTER TABLE noleadnola_submissions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'noleadnola_submissions' AND policyname = 'Service role full access'
  ) THEN
    CREATE POLICY "Service role full access" ON noleadnola_submissions FOR ALL USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'noleadnola_submissions' AND policyname = 'Public read access'
  ) THEN
    CREATE POLICY "Public read access" ON noleadnola_submissions FOR SELECT USING (true);
  END IF;
END
$$;

-- Index on address for lookups
CREATE INDEX IF NOT EXISTS idx_submissions_address ON noleadnola_submissions (address);
