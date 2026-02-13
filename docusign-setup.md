# DocuSign Embedded Signing Setup Guide

This guide walks you through configuring DocuSign for the LeadLines_Flow embedded signing feature.

## Prerequisites

- Node.js 18+
- A DocuSign Developer account (free)

---

## Step 1: Create a DocuSign Developer Account

1. Go to [developers.docusign.com](https://developers.docusign.com/)
2. Click **Get Started Free** and create an account
3. Verify your email and log in to the developer dashboard

## Step 2: Create an Integration (App)

1. In the DocuSign developer dashboard, go to **Settings > Apps & Keys**
2. Click **Add App and Integration Key**
3. Give it a name (e.g., "LeadLines Flow")
4. Copy these values — you'll need them for `.env`:

| Dashboard Field | `.env` Variable |
|----------------|-----------------|
| Integration Key | `DOCUSIGN_INTEGRATION_KEY` |
| User ID (API Username) | `DOCUSIGN_USER_ID` |
| API Account ID | `DOCUSIGN_ACCOUNT_ID` |

## Step 3: Generate RSA Keypair

**Option A: Via DocuSign Dashboard (recommended)**
1. On the same Apps & Keys page, under your app, click **Generate RSA**
2. DocuSign will show you the public and private keys
3. Copy the **private key** (the entire block including `-----BEGIN RSA PRIVATE KEY-----` and `-----END RSA PRIVATE KEY-----`)
4. Create the `config/` directory and save the private key:

```bash
mkdir -p config
# Paste the private key into this file:
nano config/docusign-private.key
```

**Option B: Via OpenSSL**
```bash
mkdir -p config
openssl genrsa -out config/docusign-private.key 2048
openssl rsa -in config/docusign-private.key -pubout -out config/docusign-public.key
```
Then upload `config/docusign-public.key` to your DocuSign app settings.

## Step 4: Add Redirect URI

1. In your app settings on the DocuSign dashboard, find **Additional settings > Redirect URIs**
2. Add: `http://localhost:3000/api/docusign/callback`
3. Click **Save**

## Step 5: Grant Consent (One-Time)

DocuSign JWT authentication requires the user to grant consent once. Open this URL in your browser (replace `{INTEGRATION_KEY}` with your actual integration key):

```
https://account-d.docusign.com/oauth/auth?response_type=code&scope=signature%20impersonation&client_id={INTEGRATION_KEY}&redirect_uri=http://localhost:3000/api/docusign/callback
```

1. Log in with your DocuSign developer account
2. Click **Allow Access**
3. You'll be redirected to the callback URL — this is expected, you can close the tab

**Note:** You only need to do this once per user/integration key combination.

## Step 6: Create a DocuSign Template

Your contract document needs to be uploaded as a DocuSign template. The app will create an envelope from this template each time someone signs.

### 6a. Upload Your Contract

1. Log in to DocuSign at [apps-d.docusign.com](https://apps-d.docusign.com) (demo environment)
2. Go to **Templates** in the top navigation
3. Click **New > Create Template**
4. Give it a name (e.g., "Lead Service Line Authorization")
5. Under **Add Documents**, upload your contract (PDF, Word, etc.)

### 6b. Add a Signer Role

1. Under **Add Recipients**, add a role:
   - **Role name**: `signer` (this must be exactly `signer` — the server uses this name)
   - **Action**: Needs to Sign
2. Click **Next** to proceed to the document editor

### 6c. Place Signing Fields

In the document editor, drag and drop fields from the left panel onto your contract:

- **Signature** — where the signer should sign
- **Date Signed** — auto-fills with the signing date
- **Name** — auto-fills with the signer's name

### 6d. (Optional) Add Pre-fill Text Fields

If you want the app to automatically fill in property details on the contract, add **Text** fields with these exact **Data Labels**:

| Data Label | What it fills in |
|-----------|-----------------|
| `propertyAddress` | The property street address |
| `parcelId` | Orleans Parish parcel ID |
| `ownerName` | Owner name from public records |
| `signerName` | Name of the person signing |

To set a data label: click the text field > **Properties** (gear icon) > **Data Label**.

These are optional — if a field doesn't exist in the template, the app will skip it.

### 6e. Save & Copy Template ID

1. Click **Save and Close**
2. Back on the Templates page, click your template name
3. Copy the **Template ID** (shown in the URL or template details)
4. Paste it into `.env` as `DOCUSIGN_TEMPLATE_ID`

## Step 7: Fill in `.env`

Open `.env` and fill in the values from steps above:

```env
# DocuSign Configuration
DOCUSIGN_INTEGRATION_KEY=your-integration-key-here
DOCUSIGN_USER_ID=your-user-id-here
DOCUSIGN_ACCOUNT_ID=your-account-id-here
DOCUSIGN_TEMPLATE_ID=your-template-id-here
DOCUSIGN_PRIVATE_KEY_PATH=config/docusign-private.key
DOCUSIGN_AUTH_SERVER=account-d.docusign.com
DOCUSIGN_BASE_PATH=https://demo.docusign.net/restapi
APP_BASE_URL=http://localhost:3000
```

## Step 8: Install & Run

```bash
npm install
npm start
```

The server starts on `http://localhost:3000`.

## Step 9: Test the Flow

1. Open `http://localhost:3000` in your browser
2. Click **Start Questionnaire**
3. Enter an Orleans Parish address
4. Fill in your info, select **I Own It**
5. On the property records step, select **Yes** for signing authority
6. Fill in contact info and click **Sign Document**
7. The DocuSign signing view should appear inline
8. Complete the signing — you should see a success page

---

## Troubleshooting

### "DocuSign is not configured"
- Check that `DOCUSIGN_INTEGRATION_KEY`, `DOCUSIGN_USER_ID`, and `DOCUSIGN_ACCOUNT_ID` are all set in `.env`
- Restart the server after changing `.env`

### "DocuSign template is not configured"
- Set `DOCUSIGN_TEMPLATE_ID` in `.env` (see Step 6)
- Restart the server after changing `.env`

### "TEMPLATE_ID_INVALID" or template errors
- Verify the template ID is correct (check the DocuSign Templates page)
- Make sure the template has a recipient role named exactly `signer`
- Ensure the template is in the same account as your `DOCUSIGN_ACCOUNT_ID`

### "consent_required" or 403 error
- You need to grant consent (Step 5 above)
- Make sure you're granting consent with the same account that owns the integration key

### "RSA private key not found"
- Ensure the private key file exists at `config/docusign-private.key`
- Check the `DOCUSIGN_PRIVATE_KEY_PATH` value in `.env`

### "Invalid grant" or JWT auth error
- Verify the private key matches what's registered in your DocuSign app
- Check that `DOCUSIGN_USER_ID` is correct (it's the API Username/User ID, not email)
- Ensure `DOCUSIGN_AUTH_SERVER` is `account-d.docusign.com` for demo

### "DocuSign signing library failed to load"
- The `js-d.docusign.com/bundle.js` script may be blocked by ad blockers
- Try disabling browser extensions or using an incognito window

### Signing view doesn't appear
- Check browser console for errors
- Ensure the integration key is correct — it's needed both server-side (JWT) and client-side (Focused View SDK)

---

## Production Notes

When moving to production:
1. Change `DOCUSIGN_AUTH_SERVER` to `account.docusign.com`
2. Change `DOCUSIGN_BASE_PATH` to `https://na1.docusign.net/restapi` (or your region)
3. In `index.html`, change the DocuSign bundle script from `js-d.docusign.com` to `js.docusign.com`
4. Update `APP_BASE_URL` to your production domain
5. Add the production redirect URI to your DocuSign app settings
6. Go through DocuSign's "Go Live" process to move your integration to production
