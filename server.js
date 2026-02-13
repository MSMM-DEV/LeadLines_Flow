require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const docusign = require('docusign-esign');

const app = express();
app.use(express.json());

// ─── Supabase Configuration ──────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SUPABASE_HEADERS = SUPABASE_URL && SUPABASE_SERVICE_KEY ? {
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
  'Prefer': 'return=representation',
} : null;

// ─── DocuSign Configuration ───────────────────────────────────────────────────

const DOCUSIGN_CONFIG = {
  integrationKey: process.env.DOCUSIGN_INTEGRATION_KEY,
  userId: process.env.DOCUSIGN_USER_ID,
  accountId: process.env.DOCUSIGN_ACCOUNT_ID,
  privateKeyPath: process.env.DOCUSIGN_PRIVATE_KEY_PATH || 'config/docusign-private.key',
  authServer: process.env.DOCUSIGN_AUTH_SERVER || 'account-d.docusign.com',
  basePath: process.env.DOCUSIGN_BASE_PATH || 'https://demo.docusign.net/restapi',
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',
  templateId: process.env.DOCUSIGN_TEMPLATE_ID,
};

// ─── JWT Token Cache ──────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiresAt = 0;

function isDocuSignConfigured() {
  return !!(
    DOCUSIGN_CONFIG.integrationKey &&
    DOCUSIGN_CONFIG.userId &&
    DOCUSIGN_CONFIG.accountId
  );
}

async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (cachedToken && Date.now() < tokenExpiresAt - 300000) {
    return cachedToken;
  }

  // Support private key from env var (Vercel) or file (local dev)
  let privateKey = process.env.DOCUSIGN_PRIVATE_KEY;
  if (!privateKey) {
    const keyPath = path.resolve(DOCUSIGN_CONFIG.privateKeyPath);
    if (!fs.existsSync(keyPath)) {
      throw new Error(
        `RSA private key not found at ${keyPath} and DOCUSIGN_PRIVATE_KEY env var not set. ` +
        'See docusign-setup.md for instructions on generating and placing the key.'
      );
    }
    privateKey = fs.readFileSync(keyPath, 'utf8');
  }

  // Build JWT assertion per DocuSign JWT Grant spec
  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign(
    {
      iss: DOCUSIGN_CONFIG.integrationKey,
      sub: DOCUSIGN_CONFIG.userId,
      aud: DOCUSIGN_CONFIG.authServer,
      scope: 'signature impersonation',
    },
    privateKey,
    {
      algorithm: 'RS256',
      expiresIn: 3600,
    }
  );

  // Exchange JWT assertion for access token
  const tokenUrl = `https://${DOCUSIGN_CONFIG.authServer}/oauth/token`;
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`DocuSign auth failed (${resp.status}): ${body}`);
  }

  const data = await resp.json();
  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

// ─── Template Helpers ─────────────────────────────────────────────────────────

function isTemplateConfigured() {
  return !!DOCUSIGN_CONFIG.templateId;
}

// ─── API Endpoints ────────────────────────────────────────────────────────────

// Expose the integration key to the frontend (needed for Focused View SDK)
app.get('/api/docusign/config', (req, res) => {
  if (!isDocuSignConfigured()) {
    return res.json({ configured: false });
  }
  res.json({
    configured: true,
    integrationKey: DOCUSIGN_CONFIG.integrationKey,
  });
});

app.post('/api/docusign/create-envelope', async (req, res) => {
  try {
    if (!isDocuSignConfigured()) {
      return res.status(503).json({
        error: 'DocuSign is not configured. See docusign-setup.md for setup instructions.',
      });
    }

    const { signerEmail, signerName, propertyAddress, parcelId, ownerName, submissionId } = req.body;

    if (!signerEmail || !signerName || !propertyAddress) {
      return res.status(400).json({
        error: 'Missing required fields: signerEmail, signerName, propertyAddress',
      });
    }

    if (!isTemplateConfigured()) {
      return res.status(503).json({
        error: 'DocuSign template is not configured. Set DOCUSIGN_TEMPLATE_ID in .env. See docusign-setup.md for instructions.',
      });
    }

    const accessToken = await getAccessToken();

    // Configure DocuSign API client
    const apiClient = new docusign.ApiClient();
    apiClient.setBasePath(DOCUSIGN_CONFIG.basePath);
    apiClient.addDefaultHeader('Authorization', `Bearer ${accessToken}`);

    // Create envelope from template
    // The signer role name must match the role defined in your DocuSign template.
    // Default role name is "signer" — update below if your template uses a different name.
    const envelopeDefinition = {
      templateId: DOCUSIGN_CONFIG.templateId,
      templateRoles: [
        {
          email: signerEmail,
          name: signerName,
          roleName: 'signer', // Must match the role name in your DocuSign template
          clientUserId: '1000', // Embedded signing — must match when requesting recipient view
          tabs: {
            // Pre-fill text tabs if they exist in the template (optional — won't error if tabs don't exist)
            textTabs: [
              { tabLabel: 'propertyAddress', value: propertyAddress },
              { tabLabel: 'parcelId', value: parcelId || '' },
              { tabLabel: 'ownerName', value: ownerName || '' },
              { tabLabel: 'signerName', value: signerName },
            ],
          },
        },
      ],
      status: 'sent', // Immediately send for signing
    };

    // Create the envelope
    const envelopesApi = new docusign.EnvelopesApi(apiClient);
    const envelope = await envelopesApi.createEnvelope(DOCUSIGN_CONFIG.accountId, {
      envelopeDefinition,
    });

    console.log(`[DocuSign] Envelope created: ${envelope.envelopeId}`);

    // Update submission row with envelope ID
    if (submissionId && SUPABASE_HEADERS) {
      try {
        await fetch(`${SUPABASE_URL}/rest/v1/noleadnola_submissions?id=eq.${submissionId}`, {
          method: 'PATCH',
          headers: SUPABASE_HEADERS,
          body: JSON.stringify({
            docusign_envelope_id: envelope.envelopeId,
            docusign_status: 'sent',
            updated_at: new Date().toISOString(),
          }),
        });
      } catch (err) {
        console.error('[DocuSign] Failed to update submission with envelope ID:', err);
      }
    }

    // Get the recipient view URL — redirect-based signing
    // After signing, DocuSign redirects the browser to returnUrl with ?event=signing_complete
    const callbackUrl = new URL(`${DOCUSIGN_CONFIG.appBaseUrl}/api/docusign/callback`);
    if (submissionId) callbackUrl.searchParams.set('submissionId', submissionId);
    const viewRequest = {
      returnUrl: callbackUrl.toString(),
      authenticationMethod: 'none',
      email: signerEmail,
      userName: signerName,
      clientUserId: '1000',
    };

    const recipientView = await envelopesApi.createRecipientView(
      DOCUSIGN_CONFIG.accountId,
      envelope.envelopeId,
      { recipientViewRequest: viewRequest }
    );

    res.json({ url: recipientView.url });
  } catch (err) {
    console.error('[DocuSign] Error creating envelope:', err);

    // Provide helpful error messages
    if (err.message?.includes('consent')) {
      return res.status(403).json({
        error: 'DocuSign consent has not been granted. See docusign-setup.md step 5.',
      });
    }

    res.status(500).json({
      error: err.message || 'Failed to create signing envelope',
    });
  }
});

// ─── Submissions API ─────────────────────────────────────────────────────────

app.post('/api/submissions', async (req, res) => {
  try {
    if (!SUPABASE_HEADERS) {
      return res.status(503).json({ error: 'Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.' });
    }

    const body = req.body;
    const ownership = body.ownership;
    const filler = body.fillerInfo || {};
    const assessor = (ownership === 'own' && body.assessorData) || {};

    // Determine property_records_match
    let propertyRecordsMatch = null;
    if (ownership === 'own' && assessor.found && assessor.ownerName) {
      const ownerUpper = (assessor.ownerName || '').toUpperCase();
      const firstUpper = (filler.firstName || '').toUpperCase().trim();
      const lastUpper = (filler.lastName || '').toUpperCase().trim();
      propertyRecordsMatch = !!(firstUpper && lastUpper && (ownerUpper.includes(firstUpper) || ownerUpper.includes(lastUpper)));
    }

    // Determine contact info and role
    let contactFirstName, contactLastName, contactEmail, contactPhone, contactRole;
    if (ownership === 'own' && body.signingAuthority === 'yes' && body.contact) {
      contactFirstName = body.contact.firstName;
      contactLastName = body.contact.lastName;
      contactEmail = body.contact.email;
      contactPhone = body.contact.phone;
      contactRole = 'signer';
    } else if (ownership === 'own' && body.signingAuthority === 'no' && body.ownerContact) {
      contactFirstName = body.ownerContact.firstName;
      contactLastName = body.ownerContact.lastName;
      contactEmail = body.ownerContact.email;
      contactPhone = body.ownerContact.phone;
      contactRole = 'owner_referral';
    } else if (ownership === 'rent' && body.ownerContact) {
      contactFirstName = body.ownerContact.firstName;
      contactLastName = body.ownerContact.lastName;
      contactEmail = body.ownerContact.email;
      contactPhone = body.ownerContact.phone;
      contactRole = 'landlord';
    }

    const row = {
      address: body.address,
      filler_first_name: filler.firstName || null,
      filler_last_name: filler.lastName || null,
      filler_email: filler.email || null,
      filler_phone: filler.phone || null,
      ownership,
      property_records_match: propertyRecordsMatch,
      signing_authority: body.signingAuthority || null,
      assessor_owner_name: assessor.ownerName || null,
      parcel_id: assessor.parcelId || null,
      legal_description: assessor.legalDescription || null,
      property_type: assessor.propertyType || null,
      year_built: assessor.yearBuilt || null,
      living_area: assessor.livingArea || null,
      lot_sqft: assessor.lotSqft || null,
      lot_dimensions: assessor.lotDimensions || null,
      land_value: assessor.landValue || null,
      assessed_value: assessor.assessedValue || null,
      taxable_value: assessor.taxableValue || null,
      tax_bill_id: assessor.taxBillId || null,
      square: assessor.square || null,
      lot: assessor.lot || null,
      contact_first_name: contactFirstName || null,
      contact_last_name: contactLastName || null,
      contact_email: contactEmail || null,
      contact_phone: contactPhone || null,
      contact_role: contactRole || null,
    };

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/noleadnola_submissions`, {
      method: 'POST',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(row),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[Submissions] Insert failed:', resp.status, errText);
      return res.status(500).json({ error: 'Failed to save submission' });
    }

    const [inserted] = await resp.json();
    console.log(`[Submissions] Saved submission #${inserted.id} for ${body.address}`);
    res.json({ id: inserted.id });
  } catch (err) {
    console.error('[Submissions] Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.patch('/api/submissions/:id/docusign', async (req, res) => {
  try {
    if (!SUPABASE_HEADERS) {
      return res.status(503).json({ error: 'Supabase is not configured.' });
    }

    const { id } = req.params;
    const { envelope_id, status } = req.body;

    const updates = { updated_at: new Date().toISOString() };
    if (envelope_id) updates.docusign_envelope_id = envelope_id;
    if (status) updates.docusign_status = status;

    const resp = await fetch(`${SUPABASE_URL}/rest/v1/noleadnola_submissions?id=eq.${id}`, {
      method: 'PATCH',
      headers: SUPABASE_HEADERS,
      body: JSON.stringify(updates),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('[Submissions] DocuSign update failed:', resp.status, errText);
      return res.status(500).json({ error: 'Failed to update submission' });
    }

    console.log(`[Submissions] Updated submission #${id} docusign: ${status || 'n/a'}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[Submissions] DocuSign update error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

app.get('/api/docusign/callback', async (req, res) => {
  // DocuSign redirects here after signing completes.
  const event = req.query.event || 'unknown';
  const submissionId = req.query.submissionId;

  // Update submission with signing result
  if (submissionId && SUPABASE_HEADERS) {
    try {
      await fetch(`${SUPABASE_URL}/rest/v1/noleadnola_submissions?id=eq.${submissionId}`, {
        method: 'PATCH',
        headers: SUPABASE_HEADERS,
        body: JSON.stringify({
          docusign_status: event,
          updated_at: new Date().toISOString(),
        }),
      });
      console.log(`[DocuSign] Updated submission #${submissionId} with status: ${event}`);
    } catch (err) {
      console.error('[DocuSign] Failed to update submission status:', err);
    }
  }

  // Redirect back to the app with the signing result as a hash parameter.
  res.redirect(`/#signing-${event}`);
});

// ─── Export for Vercel Serverless ─────────────────────────────────────────────

module.exports = app;

// ─── Start Server (local dev only) ───────────────────────────────────────────

if (require.main === module) {
  app.use(express.static(path.join(__dirname)));
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!isDocuSignConfigured()) {
      console.log('DocuSign is NOT configured — signing features will be unavailable.');
      console.log('See docusign-setup.md for configuration instructions.');
    } else if (!isTemplateConfigured()) {
      console.log('DocuSign credentials configured, but DOCUSIGN_TEMPLATE_ID is not set.');
      console.log('See docusign-setup.md for template creation instructions.');
    } else {
      console.log('DocuSign fully configured (template: ' + DOCUSIGN_CONFIG.templateId + ').');
    }
  });
}
