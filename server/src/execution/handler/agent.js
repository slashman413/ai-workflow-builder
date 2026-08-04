/**
 * handler/agent.js — agent node: call an LLM provider.
 *
 * The API key NEVER comes from the workflow or the request — it is resolved
 * from the org's encrypted key vault (VaultService.revealKey), either via an
 * explicit config.keyHandle or the first vault entry matching the provider.
 * The returned step payload contains the model's text and metadata only; no
 * key material is ever logged or stored.
 *
 * Providers: openai, anthropic, gemini, deepseek (OpenAI-compatible).
 * `ctx.fetchFn` and `ctx.signal` are injected so tests run network-free and
 * cancellation aborts in-flight calls.
 */

import { serializeContext } from '../../domain/executor/handlers.js';
import { DEFAULT_MODELS, PROVIDERS } from '../types.js';

const DEFAULT_TEMPERATURE = 0.7;
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant.';
const DEFAULT_MAX_TOKENS = 1024;

/** Compose the LLM prompt from the node objective and the current context. */
export function buildPrompt(objective, contextText) {
  return (
    `Objective: ${objective}\n\n` +
    `Context so far:\n${contextText}\n\n` +
    'Produce the best possible result for the objective.'
  );
}

/**
 * Resolve the plaintext provider key from the vault.
 *
 * @param {object} ctx engine context (vault, orgId, node)
 * @returns {{ provider: string, apiKey: string }}
 */
export function resolveVaultKey(ctx, provider) {
  const vault = ctx.vault;
  const nodeId = ctx.node.id;
  const config = ctx.node.config ?? {};
  if (!vault) {
    throw new Error(`agent node "${nodeId}": key vault is not available on this server`);
  }
  if (config.keyHandle) {
    const entry = vault.revealKey(ctx.orgId, String(config.keyHandle));
    return { provider: entry.provider ?? provider, apiKey: entry.apiKey };
  }
  const entries = vault.list(ctx.orgId).filter((e) => e.provider === provider);
  if (entries.length === 0) {
    throw new Error(
      `agent node "${nodeId}": no ${provider} API key in the vault — add one in the key vault first (or pin config.keyHandle).`,
    );
  }
  const entry = vault.revealKey(ctx.orgId, entries[0].keyHandle);
  return { provider, apiKey: entry.apiKey };
}

/** Build the provider request body from the node config + prompt. */
export function buildRequestBody(provider, config, prompt) {
  const model = config.model ?? DEFAULT_MODELS[provider];
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (provider === 'anthropic') {
    return {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    };
  }
  if (provider === 'gemini') {
    return {
      contents: [
        {
          role: 'user',
          parts: [
            { text: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: config.temperature ?? DEFAULT_TEMPERATURE,
        maxOutputTokens: maxTokens,
      },
    };
  }
  // openai + deepseek (OpenAI-compatible chat completions)
  return {
    model,
    messages: [
      { role: 'system', content: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
    temperature: config.temperature ?? DEFAULT_TEMPERATURE,
    max_tokens: maxTokens,
  };
}

/** Default API endpoints per provider (config.endpoint overrides). */
const ENDPOINTS = Object.freeze({
  openai: 'https://api.openai.com/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/models',
  deepseek: 'https://api.deepseek.com/chat/completions',
});

/** Parse the provider response into plain text (injectable fetchFn). */
export async function callProvider(provider, { apiKey, body, fetchFn = fetch, signal, endpoint }) {
  const headers =
    provider === 'anthropic'
      ? { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }
      : { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };

  let url = endpoint ?? ENDPOINTS[provider];
  if (provider === 'gemini') {
    const model = body.model;
    url = `${ENDPOINTS.gemini}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  }

  const res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${provider} API error ${res.status}: ${detail.slice(0, 500)}`);
  }
  const data = await res.json();
  return extractText(provider, data);
}

/** Pull the text out of each provider's response envelope. */
export function extractText(provider, data) {
  if (provider === 'anthropic') {
    return (data.content ?? []).map((part) => part.text ?? '').join('');
  }
  if (provider === 'gemini') {
    return (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
  }
  return data.choices?.[0]?.message?.content ?? '';
}

/**
 * @param {object} ctx engine context
 * @returns {Promise<{ provider: string, model: string, content: string }>}
 */
export async function agentHandler(ctx) {
  const config = ctx.node.config ?? {};
  const provider = config.provider && provider in PROVIDERS ? config.provider : 'openai';
  const objective = config.objective || ctx.node.name || 'achieve the goal';
  const prompt = buildPrompt(objective, serializeContext(ctx));
  const { apiKey } = resolveVaultKey(ctx, provider);
  const body = buildRequestBody(provider, config, prompt);
  const content = await callProvider(provider, {
    apiKey,
    body,
    fetchFn: ctx.fetchFn,
    signal: ctx.signal,
    endpoint: config.endpoint,
  });
  return {
    provider,
    model: body.model,
    content,
    prompt, // the composed prompt is part of the step's input/output audit trail
  };
}
