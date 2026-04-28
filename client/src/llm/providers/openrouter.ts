/**
 * OpenRouter provider — single endpoint, fan-out to any vendor.
 *
 * Uses the OpenAI-compat chat shape with two extra headers OpenRouter wants
 * for analytics. Switching the app from OpenAI direct to OpenRouter is a
 * one-tap change in AI Models (flip every task's assigned model id) — no
 * code change here.
 */
import { OpenAiCompatChatProvider } from './openaiCompat';

export const openrouterChat = new OpenAiCompatChatProvider({
  id: 'openrouter',
  url: 'https://openrouter.ai/api/v1/chat/completions',
  extraHeaders: {
    // Optional but recommended; helps OpenRouter attribute calls.
    'HTTP-Referer': 'https://github.com/sparsh-life-os',
    'X-Title': 'Life OS',
  },
});
