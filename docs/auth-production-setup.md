# Production auth setup (Clerk) — GitHub / Google sign-in

> **Status (2026-08-09):** Clerk is now **optional**. The product is self-hosted
> (MIT, download-and-run) and works out of the box in mock-auth mode — no Clerk
> key, no accounts. Follow this guide **only if** you self-host a multi-tenant
> deployment and want real GitHub/Google sign-in. The demo site
> (workflow-builders.com) is a static landing page and uses **no** Clerk at all.

> **TL;DR of the recurring "GitHub/Google sign-in does nothing" bug:** the SPA
> is deployed with a Clerk **development** key (`pk_test_…`) on the production
> domain `workflow-builders.com`. Clerk development instances only work on
> `localhost` and `*.accounts.dev`; on a real domain the dev-browser handshake
> fails (`dev_browser_unauthenticated`), so OAuth can never complete. The fix
> is a **production-instance** key (`pk_live_…`) — a deploy-secret/dashboard
> change, **not** a code change.

## How to confirm the symptom

```bash
# 1. What key is actually in the live bundle?
curl -s https://workflow-builders.com/ | grep -oE '/assets/[^"]+\.js' | head -1
curl -s https://workflow-builders.com/assets/<hash>.js | grep -oE 'pk_(test|live)_[A-Za-z0-9]+'
#   pk_test_…  → development instance → broken on prod (this bug)
#   pk_live_…  → production instance  → correct

# 2. Ask Clerk's Frontend API directly (dev instances reject prod browsers):
KEY=pk_test_...                                   # the key from step 1
FAPI="https://$(echo "${KEY#pk_test_}" | base64 -d | sed 's/\$$//')"
curl -s "$FAPI/v1/environment?_clerk_js_version=5" -H "Origin: https://workflow-builders.com"
#   {"errors":[{"code":"dev_browser_unauthenticated", ...}]}  ← confirms the bug
```

The app now also renders a red **"Sign-in is misconfigured"** banner and logs
`[auth] dev_key_on_production` to the console whenever a `pk_test_` key is
served from a non-localhost host (see `web/src/auth/AuthProvider.jsx`
`clerkEnvIssue()`), so this never fails silently again.

## The fix (one-time, in the Clerk dashboard + DNS + CI secrets)

1. **Create a Clerk production instance** for `workflow-builders.com` (Clerk
   dashboard → the app → "Production"). This mints a `pk_live_…` publishable
   key and a `sk_live_…` secret key.
2. **Configure the production domain + DNS.** Clerk gives you CNAME records for
   the production Frontend API and accounts portal, e.g.:
   - `clerk.workflow-builders.com` → `frontend-api.clerk.services`
   - `accounts.workflow-builders.com` → `accounts.clerk.services`
   - plus the `clkmail` / DKIM records Clerk lists.
   Add them in Cloudflare DNS and wait for Clerk to verify.
3. **Set up the social connections for production.** Development instances use
   Clerk's *shared* GitHub/Google OAuth apps; production instances require
   **your own** OAuth credentials:
   - **GitHub:** create an OAuth App (or use the existing publishing one) with
     Authorization callback URL
     `https://clerk.workflow-builders.com/v1/oauth_callback`. Put its
     client id/secret into Clerk → SSO Connections → GitHub.
   - **Google:** create an OAuth 2.0 Client (Google Cloud console) with the
     same authorized redirect URI, and add it to Clerk → SSO Connections →
     Google. Add `workflow-builders.com` to the OAuth consent screen's
     authorized domains.
4. **Update the deploy secrets** (GitHub → repo → Settings → Secrets → Actions):
   - `VITE_CLERK_PUBLISHABLE_KEY` → the new `pk_live_…` (consumed by the
     `deploy-web` build step in `.github/workflows/ci-cd.yml`).
   - `CLERK_SECRET_KEY` → the new `sk_live_…` on the **API** host (Fly/Railway),
     which runs `AUTH_MODE=clerk` and verifies session JWTs.
5. **Redeploy** by pushing to `main` (or re-running the `deploy-web` job). Verify
   with the two `curl` checks above — the bundle should now show `pk_live_…` and
   `/v1/environment` should return `200`.

## Why this is not a code change

`web/src/auth/AuthProvider.jsx` already selects real Clerk mode whenever
`VITE_CLERK_PUBLISHABLE_KEY` is set, `web/src/components/AuthBar.jsx` already
starts a real `authenticateWithRedirect` OAuth flow, `/sso-callback` is already
handled and served as an SPA route (`web/public/_redirects`), and the CI job
already injects the key at build time. The code path is correct; it has only
ever been fed a development key. Swap the key (steps above) and OAuth works.
