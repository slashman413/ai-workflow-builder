# AI Workflow Builder — Production Deployment Runbook

> **Goal:** Get `workflow-builders.com` (SPA) + `api.workflow-builders.com` (API) live with Clerk OAuth (GitHub + Google) working end-to-end.
>
> **Two halves, two platforms:**
> - Frontend: Cloudflare Pages (static SPA from `web/dist/`)
> - Backend API: Fly.io (Node 22 Express container with SQLite on volume)
>
> **Prerequisites before starting:**
> - You hold: GitHub account, Cloudflare account, Fly.io account, Clerk account, Stripe account (optional, for billing)
> - `~/.priv/` directory with credential files (see Step 1.4)
> - `flyctl` CLI installed
> - `wrangler` CLI installed (v4.x, already present)

---

## Step 1 — Set up Clerk Dashboard

Clerk handles authentication (session tokens, OAuth connections, allowed origins). **This is the most critical step** — without OAuth connections configured, GitHub/Google buttons will not render.

### 1.1 Create/Select Your Clerk Application

1. Log in to [Clerk Dashboard](https://clerk.com/dashboard)
2. Create a new application (or select existing one for `workflow-builders.com`)
3. Note these two values from the **API Keys** tab:
   - **Publishable Key** → `pk_...` (frontend uses this)
   - **Secret Key** → `sk_...` (backend uses this)

### 1.2 Configure Allowed Origins

In **Settings → Environment**:

1. **Allowed origins** — add ALL of these:
   ```
   https://workflow-builders.com
   https://api.workflow-builders.com
   https://*.workflow-builders.com
   https://*.pages.dev
   ```
   (These match what the frontend's `VITE_CLERK_PUBLISHABLE_KEY` expects AND what the backend's `corsMiddleware` allows.)

2. **Redirect URLs** — ensure these are present:
   ```
   https://workflow-builders.com/*
   https://workflow-builders.com/sso-callback
   ```

### 1.3 Enable GitHub OAuth

1. Go to **Authentication → Social Connections → GitHub**
2. **Enable** the GitHub provider
3. You need a **GitHub OAuth App** first:
   - Go to https://github.com/settings/developers → **New OAuth App**
   - **Application name:** `AI Workflow Builder`
   - **Homepage URL:** `https://workflow-builders.com`
   - **Authorization callback URL:**
     ```
     https://workflow-builders.com/v1/auth/callback?redirectUrl=/sso-callback&strategy=oauth_github
     ```
   - **IMPORTANT:** After creating the GitHub OAuth app, you'll get:
     - **Client ID**
     - **Client Secret** (click "Generate a new secret" — save this immediately, it won't be shown again)
4. Back in Clerk:
   - Paste the **Client ID**
   - Paste the **Client Secret**
   - **Scopes:** `read:user user:email`
   - Click **Save**

### 1.4 Enable Google OAuth

1. Go to **Authentication → Social Connections → Google**
2. **Enable** the Google provider
3. You need a **Google OAuth 2.0 Client** first:
   - Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   - **Create OAuth 2.0 Client ID** → **Web application**
   - **Authorized JavaScript origins:**
     ```
     https://workflow-builders.com
     https://*.workflow-builders.com
     https://*.pages.dev
     https://clerk.example.com  (if using dev)
     ```
   - **Authorized redirect URIs:**
     ```
     https://workflow-builders.com/v1/auth/callback?redirectUrl=/sso-callback&strategy=oauth_google
     ```
   - After creating, you get:
     - **Client ID**
     - **Client Secret**
4. Back in Clerk:
   - Paste the **Client ID**
   - Paste the **Client Secret**
   - Click **Save**

### 1.5 Record Your Clerk Values

Save these to a safe location (not in the repo):

```
VITE_CLERK_PUBLISHABLE_KEY=pk_live_...   # or pk_test_...
CLERK_SECRET_KEY=sk_live_...             # or sk_test_...
```

> **Tip:** You can use `test` keys initially and switch to `live` keys later. Test mode has no restrictions.

---

## Step 2 — Prepare Credentials

### 2.1 Fly.io API Token

1. Log in to [Fly.io Dashboard](https://fly.io/dashboard)
2. Go to **Account → API Tokens**
3. Copy your API token
4. Save it to `~/.priv/fly_api_token`:
   ```bash
   echo 'YOUR_FLY_API_TOKEN_HERE' > ~/.priv/fly_api_token
   chmod 600 ~/.priv/fly_api_token
   ```

### 2.2 Cloudflare Pages Token (Already Available)

These are already in `~/.priv/`:

| File | Purpose |
|------|---------|
| `ckw19810413-cloudflare-api-token` | Full API token (for Wrangler actions) |
| `ckw19810413-cloudflare-pages-dns-token` | Pages/DNS token (if needed) |

### 2.3 GitHub OAuth App (Backend — for repo publishing)

Separate from the Clerk GitHub OAuth above. This is for the **publish workflow** feature:

1. Go to https://github.com/settings/developers → **New OAuth App**
2. **Application name:** `AI Workflow Builder API`
3. **Homepage URL:** `https://workflow-builders.com`
4. **Authorization callback URL:**
   ```
   https://api.workflow-builders.com/api/github/callback
   ```
5. Record the **Client ID** and **Client Secret**

### 2.4 Stripe (Optional — for billing)

If you want to enable Team tier billing ($99/mo):

1. Go to [Stripe Dashboard](https://dashboard.stripe.com)
2. Record: `STRIPE_SECRET_KEY` (from API Keys), `STRIPE_WEBHOOK_SECRET` (from Webhooks), `STRIPE_TEAM_PRICE_ID` (from Products → Pricing)

---

## Step 3 — Deploy Backend API to Fly.io

### 3.1 Create Fly.io App (One-time)

```bash
cd /home/wayne/workspace/github/slashman413/ai-workflow-builder/

# Login to Fly.io if not already
fly auth login

# Launch the app (this reads fly.toml)
# If the app already exists, skip this step
fly launch --no-deploy
```

This creates the Fly.io app and generates a `fly.toml` at the repo root. The `fly.toml` already has the correct configuration:
- `app = "ai-workflow-builder-api"`
- `primary_region = "syd"`
- Container health check on `/api/health`
- Volume mount at `/data`

### 3.2 Create SQLite Volume (One-time)

```bash
fly volumes create awb_data --size 1 --region syd
```

This creates a 1GB persistent volume for SQLite.

### 3.3 Configure Environment Variables on Fly.io

Set all required environment variables. Replace placeholders with actual values:

```bash
# Required for Clerk auth (MUST be set)
fly secrets set CLERK_SECRET_KEY="sk_live_...or_sk_test_..."
fly secrets set NODE_ENV="production"
fly secrets set DB_FILE="/data/app.db"

# Required for the LLM key vault
fly secrets set VAULT_KEK="$(python3 -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode())")"

# GitHub OAuth for publishing feature
fly secrets set GITHUB_CLIENT_ID="your_github_oauth_client_id"
fly secrets set GITHUB_CLIENT_SECRET="your_github_oauth_client_secret"
fly secrets set GITHUB_REDIRECT_URI="https://api.workflow-builders.com/api/github/callback"

# Optional but recommended
fly secrets set CORS_ORIGINS="https://workflow-builders.com"
```

> **Important:** The `VAULT_KEK` must be exactly 32 bytes (base64-encoded = 44 chars). The one-liner above generates a random key. **Save this value** — if you lose it, you cannot decrypt previously stored vault entries.

### 3.4 Deploy the API

```bash
fly deploy
```

This builds the Dockerfile (multi-stage, Node 22-slim) and deploys it to Fly.io.

### 3.5 Verify the API

```bash
# Health check
curl -s https://api.workflow-builders.com/api/health | python3 -m json.tool

# Should return:
# {
#   "status": "ok",
#   "service": "ai-workflow-builder-server",
#   "version": "1.0.0",
#   "uptime": <seconds>,
#   "timestamp": "<ISO>",
#   "db": { "ok": true }
# }
```

> **Note:** If `api.workflow-builders.com` returns HTTP 000 (connection refused), verify:
> 1. `fly status` shows running instances
> 2. `fly logs` shows successful startup
> 3. The DNS `CNAME` record `api.workflow-builders.com` points to your Fly.io app URL (e.g., `ai-workflow-builder-api.fly.dev`)

---

## Step 4 — Deploy Frontend to Cloudflare Pages

### 4.1 Create Cloudflare Pages Project (One-time)

You have two options:

#### Option A: Via Cloudflare Dashboard (Recommended for first deployment)

1. Go to [Cloudflare Dashboard → Pages](https://dash.cloudflare.com/pages)
2. Click **Create a project** → **Direct Upload**
3. Name it `ai-workflow-builder-web`
4. Click **Create project**

Then configure:
- **Build command:** `npm run build`
- **Output directory:** `dist` (relative to `web/`)
- **Root directory:** `web`

#### Option B: Via Cloudflare API Token (Automated)

If you've already created the project in the dashboard, the CI/CD pipeline (`ci-cd.yml`) handles future deployments automatically using `cloudflare/wrangler-action@v3`.

### 4.2 Set Cloudflare Repository Secrets

If using CI/CD (recommended), go to:
- **GitHub → ai-workflow-builder → Settings → Secrets and variables → Actions**
- Add these secrets:

| Secret Name | Source |
|------------|--------|
| `CLOUDFLARE_API_TOKEN` | Content of `~/.priv/ckw19810413-cloudflare-api-token` |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID (from dashboard or `wrangler whoami`) |
| `VITE_CLERK_PUBLISHABLE_KEY` | Your Clerk publishable key (`pk_...`) |
| `VITE_API_URL` | `https://api.workflow-builders.com/api` |
| `FLY_API_TOKEN` | Content of `~/.priv/fly_api_token` |

Get your Cloudflare Account ID:
```bash
wrangler whoami | grep 'account_id'
```

### 4.3 Manual Deploy (Quick Test)

To deploy manually without CI:

```bash
cd /home/wayne/workspace/github/slashman413/ai-workflow-builder/

# Build with production API URL
VITE_CLERK_PUBLISHABLE_KEY="pk_test_..." \
VITE_API_URL="https://api.workflow-builders.com/api" \
npm run build

# Deploy to Cloudflare Pages
wrangler pages deploy web/dist \
  --project-name=ai-workflow-builder-web \
  --branch=main \
  --api-token="$(cat ~/.priv/ckw19810413-cloudflare-api-token)"
```

### 4.4 Configure DNS

Ensure DNS records exist in your Cloudflare dashboard for `slashman413.com` / `workflow-builders.com`:

| Type | Name | Content | Proxy |
|------|------|---------|-------|
| CNAME | `@` or `workflow-builders.com` | `<project-id>.pages.dev` | Orange (proxied) |
| CNAME | `api` | `<fly-app-name>.fly.dev` | Orange (proxied) |

> **Note:** Cloudflare Pages automatically creates a `.pages.dev` subdomain. The CNAME records point your custom domains to these.

---

## Step 5 — Configure Backend CORS for Production

The backend CORS middleware (`server/src/adapters/http/cors.js`) has these rules:

- **Production origin (exact match):** `https://workflow-builders.com`
- **Patterns (always honored):** `https://*.pages.dev`, `https://*.workflow-builders.com`

These should already work. If you have issues, verify the Fly.io app is setting `NODE_ENV=production`:

```bash
fly secrets set NODE_ENV="production"
fly deploy  # restart with new env
```

---

## Step 6 — End-to-End Verification

### 6.1 Test the Frontend

1. Open `https://workflow-builders.com` in a browser
2. You should see the "Sign in to your workspace" screen
3. Click **Continue with GitHub** — the Clerk OAuth modal should appear
4. If it doesn't: check the browser console for errors. Common issues:
   - **Clerk key mismatch** — frontend uses test key but GitHub OAuth is configured for live (or vice versa)
   - **Allowed origins missing** — Clerk rejects the redirect
   - **Redirect URL not registered** — Clerk redirects to a URL it doesn't know

### 6.2 Test Clerk OAuth Callback

When you click "Continue with GitHub/Google", Clerk redirects to:
```
https://workflow-builders.com/v1/auth/callback?redirectUrl=/sso-callback&strategy=oauth_github
```

The frontend's `AuthBar.jsx` handles this via `<AuthenticateWithRedirectCallback />` and then redirects to `/sso-callback`, which shows the OAuth buttons or signed-in state.

### 6.3 Test Backend Auth

After signing in:

1. Open the browser DevTools → Network tab
2. Perform any action (e.g., list projects)
3. Check the request to `https://api.workflow-builders.com/api/projects`
4. Verify the `Authorization` header contains a `Bearer eyJ...` token (Clerk session JWT)
5. Verify the response is `200 OK` with the project list (should be empty initially)

If the API returns `401 Unauthorized`:
- Verify `CLERK_SECRET_KEY` is correctly set on Fly.io
- Verify the Clerk instance is using the **same environment** (test/live) as the frontend
- Check Fly.io logs: `fly logs --tail`

### 6.4 Test Vault (LLM Key Storage)

1. Sign in as a user with "architect" or higher role
2. Try storing an LLM API key in the vault
3. Verify it persists across page reloads
4. Verify the API returns encrypted (never plaintext)

### 6.5 Test GitHub OAuth (Publishing)

1. In the workspace, go to the publish/github section
2. Click "Connect GitHub" — this triggers the backend's OAuth dance
3. Backend redirects to `https://api.workflow-builders.com/api/github/callback`
4. After authorizing, you should see your repositories listed

### 6.6 Test Workflow Execution

1. Create a project with a prompt
2. Go through the Grill-Me spec loop
3. Scaffold a workflow
4. Try running it (Increment 5 feature)

---

## Step 7 — Stripe Billing (Optional)

If you want to enable the Team tier:

### 7.1 Set up Stripe Webhook

1. In [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks):
2. **Add endpoint:** `https://api.workflow-builders.com/api/billing/webhook`
3. **Select events:** `checkout.session.completed`, `customer.subscription.*`, `invoice.*`
4. **Copy the webhook signing secret** → `whsec_...`

### 7.2 Set Stripe Secrets on Fly.io

```bash
fly secrets set STRIPE_SECRET_KEY="sk_live_..."
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
fly secrets set STRIPE_TEAM_PRICE_ID="price_..."
fly deploy
```

---

## Troubleshooting

### Problem: `api.workflow-builders.com` returns HTTP 000 (no response)

```bash
# Check Fly.io status
fly status

# Check Fly.io logs (real-time)
fly logs --tail

# Check Fly.io deployments
fly deployments current
fly deployments list

# If no instances running:
fly scale count 1
fly deploy
```

### Problem: Clerk OAuth buttons don't render

1. **Check the frontend console:** Look for Clerk SDK errors
2. **Verify publishable key:** Is the key's environment (test/live) matching the OAuth config?
3. **Verify allowed origins:** Does Clerk's allowed origins include `https://workflow-builders.com`?
4. **Verify OAuth connections are ENABLED** in Clerk dashboard (not just created)

### Problem: Backend returns 401 on every request

1. **Verify CLERK_SECRET_KEY on Fly.io:**
   ```bash
   fly secrets list | grep CLERK_SECRET_KEY
   ```
2. **Check Clerk environment:** Is the frontend using `pk_test_` and the backend `sk_test_`? Both must be the same environment.
3. **Check the JWT:** Inspect the Bearer token in the Network tab — does it have a valid `exp` (expiry) and `org_id` claim?

### Problem: CORS errors in the browser

The `corsMiddleware` should handle this automatically. Verify:
1. The origin being requested matches the allow-list
2. `NODE_ENV=production` is set on the API (for strict origin matching)
3. No Cloudflare proxy issues — check the `Access-Control-Allow-Origin` header

### Problem: Cloudflare Pages deploy fails

1. **Check Cloudflare Pages logs** in the dashboard
2. **Verify `CLOUDFLARE_ACCOUNT_ID`** is correct
3. **Check `wrangler.toml`** — ensure `build.command` and `build.output_directory` match

---

## Post-Deployment Checklist

- [ ] `https://workflow-builders.com` loads (Cloudflare Pages)
- [ ] `https://api.workflow-builders.com/api/health` returns `{"status":"ok"}` (Fly.io)
- [ ] GitHub OAuth in Clerk works (sign-in button → Clerk modal → callback → workspace)
- [ ] Google OAuth in Clerk works (sign-in button → Clerk modal → callback → workspace)
- [ ] Backend receives Clerk session JWT (check Network tab for Bearer token)
- [ ] Vault stores/returns LLM keys (encrypted round-trip)
- [ ] GitHub OAuth (publishing) works (backend OAuth dance)
- [ ] DNS CNAME records propagate (`workflow-builders.com` and `api.workflow-builders.com`)
- [ ] Cloudflare proxy is enabled (orange cloud) for both domains
- [ ] CI/CD pipeline triggers on push to `main` (test with a trivial commit)

---

## Rollback

### Rollback API to previous Fly.io deployment:
```bash
fly deploy rollback
```

### Rollback Frontend by force-deploying an old commit:
```bash
git checkout <old-commit>
wrangler pages deploy web/dist \
  --project-name=ai-workflow-builder-web \
  --branch=main \
  --api-token="$(cat ~/.priv/ckw19810413-cloudflare-api-token)"
```

---

## Quick Reference: All Tokens & Keys You Need

| Token/Key | Where to Get | Where to Store |
|-----------|-------------|----------------|
| `VITE_CLERK_PUBLISHABLE_KEY` | Clerk Dashboard → API Keys | GitHub repo secret + build env |
| `CLERK_SECRET_KEY` | Clerk Dashboard → API Keys | Fly.io secret + GitHub repo secret |
| `FLY_API_TOKEN` | Fly.io → Account → API Tokens | `~/.priv/fly_api_token` |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → API Tokens | `~/.priv/ckw19810413-cloudflare-api-token` + GitHub repo secret |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard (or `wrangler whoami`) | GitHub repo secret |
| GitHub OAuth Client ID/Secret (Clerk) | GitHub → Settings → OAuth Apps | Clerk dashboard |
| Google OAuth Client ID/Secret (Clerk) | Google Cloud Console → Credentials | Clerk dashboard |
| VAULT_KEK | Generate: `python3 -c "import base64,os; print(base64.b64encode(os.urandom(32)).decode())"` | Fly.io secret (**save this!**) |
| GitHub OAuth Client ID/Secret (backend) | GitHub → Settings → OAuth Apps | Fly.io secret |
| Stripe keys (optional) | Stripe Dashboard | Fly.io secret |