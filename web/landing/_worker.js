/**
 * Cloudflare Pages _worker.js
 * Edge functions for workflow-builders.com
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
        },
      });
    }

    // Auth Providers Discovery Endpoint (NextAuth / Auth.js standard)
    if (
      url.pathname === "/api/auth/providers" ||
      url.pathname === "/api/auth/providers/"
    ) {
      const providers = {
        google: {
          id: "google",
          name: "Google",
          type: "oauth",
          signinUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          callbackUrl: `${url.origin}/api/auth/callback/google`,
        },
      };

      const body = request.method === "HEAD" ? null : JSON.stringify(providers, null, 2);

      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Auth-Providers": "google",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // Google Email Subscription Endpoint
    if (url.pathname === "/api/subscribe/google" && request.method === "POST") {
      try {
        const payload = await request.json();
        let forwardOk = false;
        try {
          const res = await fetch("https://api.slashmantools.us/subscribe/google", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              source: "workflow-builders-google",
              tags: "workflow-builders,google-auth",
            }),
          });
          if (res.ok) forwardOk = true;
        } catch (_) {}

        return new Response(
          JSON.stringify({
            ok: true,
            provider: "google",
            message: "Successfully subscribed to workflow-builders.com updates!",
            forwarded: forwardOk,
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // Standard Email Subscription Endpoint
    if (url.pathname === "/api/subscribe" && request.method === "POST") {
      try {
        const payload = await request.json();
        try {
          await fetch("https://api.slashmantools.us/subscribe", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...payload,
              source: "workflow-builders-email",
              tags: "workflow-builders,newsletter",
            }),
          });
        } catch (_) {}

        return new Response(
          JSON.stringify({
            ok: true,
            message: "Thank you for subscribing to workflow-builders.com!",
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ ok: false, error: err.message }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
            },
          }
        );
      }
    }

    // Fallback to static assets
    return env.ASSETS.fetch(request);
  },
};
