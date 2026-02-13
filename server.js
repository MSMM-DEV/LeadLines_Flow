require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const docusign = require('docusign-esign');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

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

  const keyPath = path.resolve(DOCUSIGN_CONFIG.privateKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `RSA private key not found at ${keyPath}. ` +
      'See docusign-setup.md for instructions on generating and placing the key.'
    );
  }

  const privateKey = fs.readFileSync(keyPath, 'utf8');

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

    const { signerEmail, signerName, propertyAddress, parcelId, ownerName } = req.body;

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

    // Get the recipient view URL — redirect-based signing
    // After signing, DocuSign redirects the browser to returnUrl with ?event=signing_complete
    const viewRequest = {
      returnUrl: `${DOCUSIGN_CONFIG.appBaseUrl}/api/docusign/callback`,
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

app.get('/api/docusign/callback', (req, res) => {
  // DocuSign redirects here after signing completes.
  // Redirect back to the app with the signing result as a hash parameter.
  const event = req.query.event || 'unknown';
  res.redirect(`/#signing-${event}`);
});

// ─── Start Server ─────────────────────────────────────────────────────────────

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
