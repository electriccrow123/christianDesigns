// Claude on the self-hosted server, through the official Anthropic SDK.
// Reads ANTHROPIC_API_KEY (or an `ant auth login` profile) from the environment.

import Anthropic from '@anthropic-ai/sdk';
import { parseJsonLoose } from '../core/util.js';

export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const EFFORT = { quick: 'low', default: 'medium', complex: 'high' };
let useFallbacks = process.env.CLAUDE_FALLBACKS !== 'off';

let client = null;
export function available() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}
function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

function requestParams({ messages, tools, tier, effort, maxTokens }) {
  const p = {
    model: MODEL,
    max_tokens: maxTokens || 32000,
    output_config: { effort: effort || EFFORT[tier] || 'medium' },
    messages,
  };
  if (tools?.length) p.tools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema || t.inputSchema || { type: 'object', properties: {} }, eager_input_streaming: true }));
  if (useFallbacks) {
    // Server-side refusal fallback: on a policy decline the API re-runs the request on a fallback model.
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

/**
 * One streamed Messages API call. Returns the final Message.
 * onText(delta) receives text as it is written.
 */
export async function complete({ messages, tools, tier, effort, onText, signal, maxTokens }) {
  const c = getClient();
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = requestParams({ messages, tools, tier, effort, maxTokens });
    try {
      const stream = useFallbacks ? c.beta.messages.stream(params, { signal }) : c.messages.stream(params, { signal });
      if (onText) stream.on('text', (delta) => onText(delta));
      return await stream.finalMessage();
    } catch (err) {
      // Accounts without the fallback beta get a 400 naming it: retry once without.
      if (useFallbacks && err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
        useFallbacks = false;
        continue;
      }
      throw toFriendly(err);
    }
  }
  throw new Error('Claude request failed.');
}

function toFriendly(err) {
  let code = 'upstream_error';
  let message = err?.message || 'Claude request failed.';
  if (err instanceof Anthropic.AuthenticationError) {
    code = 'not_granted';
    message = 'The server’s Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY and restart.';
  } else if (err instanceof Anthropic.RateLimitError) {
    code = 'rate_limited';
    message = 'Claude rate limit reached. Try again shortly.';
  } else if (err instanceof Anthropic.BadRequestError) {
    code = 'invalid_request';
  } else if (err instanceof Anthropic.APIUserAbortError || err?.name === 'AbortError') {
    code = 'cancelled';
    message = 'Stopped.';
  } else if (err instanceof Anthropic.APIConnectionError) {
    code = 'upstream_error';
    message = 'Could not reach the Claude API.';
  }
  return Object.assign(new Error(message), { code });
}

const textOf = (msg) => (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');

/** Ask for JSON: one user turn, the reply parsed tolerantly. */
export async function json(prompt, { tier, effort, signal } = {}) {
  const msg = await complete({ messages: [{ role: 'user', content: prompt }], tier, effort, signal });
  if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request.'), { code: 'refused' });
  try {
    return parseJsonLoose(textOf(msg));
  } catch {
    throw Object.assign(new Error('An agent replied in an unexpected format.'), { code: 'invalid_json', text: textOf(msg) });
  }
}

/**
 * Server-side text call with optional tools (used by the autopilot; the browser runs its own loop
 * through /api/ai/messages for chat). tools: [{name, description, inputSchema, execute}]
 */
export async function text(input, { tier, effort, onText, signal, tools } = {}) {
  const messages = typeof input === 'string' ? [{ role: 'user', content: input }] : input.map((m) => ({ role: m.role, content: m.content }));
  let full = '';
  for (let round = 0; round < 8; round++) {
    const prefix = full ? full + '\n\n' : '';
    let turn = '';
    const msg = await complete({ messages, tools, tier, effort, signal, onText: (d) => {
      turn += d;
      onText?.({ text: prefix + turn, delta: d });
    } });
    if (turn) full = prefix + turn;
    if (msg.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined this request.'), { code: 'refused', text: full });
    const uses = msg.content.filter((b) => b.type === 'tool_use');
    if (msg.stop_reason !== 'tool_use' || !uses.length) return { text: full || textOf(msg), truncated: msg.stop_reason === 'max_tokens' };
    messages.push({ role: 'assistant', content: msg.content });
    const results = [];
    for (const u of uses) {
      const tool = tools?.find((t) => t.name === u.name);
      try {
        const out = tool ? await tool.execute(u.input || {}, { signal }) : `Unknown tool ${u.name}`;
        results.push({ type: 'tool_result', tool_use_id: u.id, content: typeof out === 'string' ? out : JSON.stringify(out).slice(0, 30000) });
      } catch (err) {
        results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Error: ${err.message}` });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { text: full, truncated: true };
}

export function serverAI() {
  return { available: available(), json, text };
}
