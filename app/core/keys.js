/**
 * API key status checks.
 *
 * "Is this key still good, what can it do, and how much headroom is left?"
 * Every check is a single read-only call to the provider itself. Keys are never
 * sent anywhere else — and the app is blunt about the trade-off: a key typed
 * into a browser is a key visible to anyone who can open devtools on that
 * machine, which is exactly why providers label the browser route "dangerous".
 *
 * The CORS column below was measured against the live endpoints, not copied from
 * a blog post. Anthropic genuinely needs its special header; without it the
 * response carries no Access-Control-Allow-Origin at all.
 */

const CORS_OK = { ok: true };
const CORS_HEADER = { ok: true, needs: 'anthropic-dangerous-direct-browser-access: true' };

export const PROVIDERS = [
  {
    id: 'github',
    name: 'GitHub',
    kind: 'Developer',
    keyLabel: 'Personal access token',
    prefixHint: 'github_pat_… or ghp_…',
    tokenUrl: 'https://github.com/settings/personal-access-tokens',
    cors: CORS_OK,
    cheapestCall: 'GET /user',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json' },
      });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const scopes = res.headers.get('x-oauth-scopes');
      const expiry = res.headers.get('github-authentication-token-expiration');
      const limit = res.headers.get('x-ratelimit-limit');
      const remaining = res.headers.get('x-ratelimit-remaining');
      const fineGrained = String(key).startsWith('github_pat_');
      const days = expiry ? Math.round((new Date(expiry).getTime() - Date.now()) / 86400000) : null;
      return {
        http: res.status,
        body,
        meta: {
          Identity: body.login ? `@${body.login}${body.name ? ` (${body.name})` : ''}` : 'unknown',
          'Token type': fineGrained ? 'fine-grained' : 'classic',
          Expiry: expiry ? `${expiry}${days !== null ? ` — ${days} day${days === 1 ? '' : 's'} left` : ''}` : fineGrained ? 'none set' : 'no expiry',
          Scopes: fineGrained ? 'fine-grained (permissions are per-repository)' : (scopes || '(none)'),
          'API calls left': limit && remaining ? `${remaining} of ${limit} this hour` : 'unknown',
        },
        warn: days !== null && days <= 7 ? `This token expires in ${days} day${days === 1 ? '' : 's'}.` : null,
      };
    },
  },
  {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'sk-ant-…',
    tokenUrl: 'https://console.anthropic.com/settings/keys',
    cors: CORS_HEADER,
    cheapestCall: 'GET /v1/models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.anthropic.com/v1/models?limit=20', {
        headers: {
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
      });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.data || []).map((m) => m.id);
      return {
        http: res.status,
        body,
        meta: {
          Models: `${models.length} available`,
          Newest: models[0] || 'unknown',
          'Rate limit': [res.headers.get('anthropic-ratelimit-requests-limit') && `${res.headers.get('anthropic-ratelimit-requests-limit')} req/min`].filter(Boolean).join(' ') || 'not reported on this endpoint',
        },
      };
    },
  },
  {
    id: 'google',
    name: 'Google Gemini',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'AIza…',
    tokenUrl: 'https://aistudio.google.com/app/apikey',
    cors: CORS_OK,
    cheapestCall: 'GET /v1beta/models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.models || []).map((m) => String(m.name).replace('models/', ''));
      const withText = (body.models || []).filter((m) => (m.supportedGenerationMethods || []).includes('generateContent')).length;
      return {
        http: res.status,
        body,
        meta: {
          Models: `${models.length} listed (${withText} can generate text)`,
          Examples: models.slice(0, 3).join(', ') || 'none',
        },
      };
    },
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'sk-or-v1-…',
    tokenUrl: 'https://openrouter.ai/settings/keys',
    cors: CORS_OK,
    cheapestCall: 'GET /api/v1/key',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const data = body.data || {};
      const spend = Number(data.usage || 0);
      const limit = data.limit === null || data.limit === undefined ? null : Number(data.limit);
      return {
        http: res.status,
        body,
        meta: {
          Label: data.label || 'unnamed key',
          'Free tier': data.is_free_tier ? 'yes' : 'no',
          Spend: limit ? `$${spend.toFixed(2)} of $${limit.toFixed(2)}` : `$${spend.toFixed(2)} (no limit set)`,
          'Limit left': limit ? `$${Math.max(0, limit - spend).toFixed(2)}` : 'unlimited',
        },
        warn: limit && spend / limit > 0.9 ? 'This key is close to its spending limit.' : null,
      };
    },
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'gsk_…',
    tokenUrl: 'https://console.groq.com/keys',
    cors: CORS_OK,
    cheapestCall: 'GET /openai/v1/models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.data || []).map((m) => m.id);
      return { http: res.status, body, meta: { Models: `${models.length} available`, Examples: models.slice(0, 3).join(', ') } };
    },
  },
  {
    id: 'mistral',
    name: 'Mistral',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'no fixed prefix — it is a 32-character string',
    tokenUrl: 'https://console.mistral.ai/api-keys/',
    cors: CORS_OK,
    cheapestCall: 'GET /v1/models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.mistral.ai/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.data || []).map((m) => m.id);
      return { http: res.status, body, meta: { Models: `${models.length} available`, Examples: models.slice(0, 3).join(', ') } };
    },
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'sk-…',
    tokenUrl: 'https://platform.deepseek.com/api_keys',
    cors: CORS_OK,
    cheapestCall: 'GET /models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.deepseek.com/models', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.data || []).map((m) => m.id);
      return { http: res.status, body, meta: { Models: `${models.length} available`, Examples: models.join(', ') } };
    },
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    kind: 'AI',
    keyLabel: 'Access token',
    prefixHint: 'hf_…',
    tokenUrl: 'https://huggingface.co/settings/tokens',
    cors: CORS_OK,
    cheapestCall: 'GET /api/whoami-v2',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const orgs = (body.orgs || []).map((o) => o.name);
      return {
        http: res.status,
        body,
        meta: {
          Identity: body.name || body.fullname || 'unknown',
          Type: body.type || 'user',
          Organizations: orgs.length ? orgs.slice(0, 5).join(', ') : 'none',
        },
      };
    },
  },
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'AI',
    keyLabel: 'API key',
    prefixHint: 'sk-… / sk-proj-…',
    tokenUrl: 'https://platform.openai.com/api-keys',
    cors: { ok: true, measured: 'The live endpoints do send CORS headers today (verified from this machine). If your browser still refuses the call, OpenAI is blocking the origin — use the helper script, which is not a browser and therefore not subject to CORS.' },
    cheapestCall: 'GET /v1/models',
    async check(key, { fetchImpl = fetch } = {}) {
      const res = await fetchImpl('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${key}` } });
      const body = await safeJson(res);
      if (!res.ok) return { http: res.status, body };
      const models = (body.data || []).map((m) => m.id);
      const org = res.headers.get('openai-organization');
      return {
        http: res.status,
        body,
        warn: res.headers.get('openai-processing-ms') ? null : null,
        meta: {
          Models: `${models.length} available`,
          Organization: org || 'not reported',
          Examples: models.slice(0, 3).join(', '),
        },
      };
    },
  },
];

export function providerById(id) { return PROVIDERS.find((p) => p.id === id) || null; }

async function safeJson(res) {
  try { return await res.clone().json(); } catch { return null; }
}

/**
 * Normalise one check into a verdict a human can act on.
 * The interesting case is 429: a rate-limited key is a *working* key.
 */
export async function checkKey(providerId, key, { fetchImpl = fetch } = {}) {
  const provider = providerById(providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  const trimmed = String(key == null ? '' : key).trim();
  if (!trimmed) return { status: 'empty', message: 'Paste a key first', provider: provider.id };

  const started = Date.now();
  try {
    const result = await provider.check(trimmed, { fetchImpl });
    const ms = Date.now() - started;

    if (result.http >= 200 && result.http < 300) {
      return {
        status: 'valid', http: result.http, ms, provider: provider.id, name: provider.name,
        meta: result.meta || {}, warn: result.warn || null,
        message: 'Key is valid',
      };
    }
    if (result.http === 401) {
      return { status: 'invalid', http: 401, ms, provider: provider.id, name: provider.name, message: 'Rejected: the key is wrong, revoked or expired' };
    }
    if (result.http === 429) {
      return {
        status: 'limited', http: 429, ms, provider: provider.id, name: provider.name,
        message: 'Key works — but you are over the rate limit right now. This is a working key, throttled.',
        meta: { Retry: 'wait a minute and try again' },
      };
    }
    if (result.http === 403) {
      return { status: 'restricted', http: 403, ms, provider: provider.id, name: provider.name, message: 'Key recognised, but it lacks permission for this call (check the key\'s scopes or the project it belongs to)' };
    }
    if (result.http === 402) {
      return { status: 'billing', http: 402, ms, provider: provider.id, name: provider.name, message: 'Key works, but the account is out of credit' };
    }
    const detail = result.body && (result.body.error?.message || result.body.message || result.body.detail);
    return { status: 'error', http: result.http, ms, provider: provider.id, name: provider.name, message: `Provider returned HTTP ${result.http}${detail ? `: ${String(detail).slice(0, 160)}` : ''}` };
  } catch (err) {
    const ms = Date.now() - started;
    const isAbort = err && err.name === 'AbortError';
    return {
      status: isAbort ? 'timeout' : 'blocked',
      ms, provider: provider.id, name: provider.name,
      message: isAbort
        ? 'The request timed out.'
        : 'The browser could not reach the provider — this is usually CORS or an offline network. A provider that does not allow browser calls must be checked with the helper script instead.',
      detail: String(err && err.message || err).slice(0, 200),
    };
  }
}

/** Check every provider that has a key, one after another. */
export async function checkAll(keys, { fetchImpl = fetch, onResult = null } = {}) {
  const out = [];
  for (const provider of PROVIDERS) {
    const key = keys[provider.id];
    if (!key) continue;
    const result = await checkKey(provider.id, key, { fetchImpl });
    out.push(result);
    if (onResult) onResult(result);
  }
  return out;
}

export const KEY_SECURITY_NOTE = 'Keys live in this tab\'s memory unless you tick "remember on this device", in which case they go to this browser\'s localStorage only. They are sent to the provider and nowhere else — OmniBox has no server to send them to. But be clear-eyed about it: a key typed into a browser is readable by anyone who can open devtools on this machine. Use short-lived, least-privilege keys here.';
