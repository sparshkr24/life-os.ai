/**
 * Shared OpenAI-compat chat completions implementation. Used as-is by OpenAI
 * and (via thin subclasses) by MiniMax and DeepSeek, all of which expose
 * `/v1/chat/completions` with the same request/response shape.
 *
 * Anthropic does NOT use this — see `anthropic.ts`.
 */
import { findModel } from '../models';
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderId,
  StopReason,
  ToolCall,
} from '../types';
import type { ChatProvider } from './base';

interface OpenAiToolCallWire {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAiMessageWire {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: OpenAiToolCallWire[];
  tool_call_id?: string;
}

interface OpenAiChoiceWire {
  message?: OpenAiMessageWire;
  finish_reason?: string;
}

interface OpenAiResponseWire {
  choices?: OpenAiChoiceWire[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string };
}

export interface OpenAiChatConfig {
  id: ProviderId;
  url: string;
  /** Optional headers to merge in (e.g. organization id). */
  extraHeaders?: Record<string, string>;
}

export class OpenAiCompatChatProvider implements ChatProvider {
  readonly id: ProviderId;
  private readonly url: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(cfg: OpenAiChatConfig) {
    this.id = cfg.id;
    this.url = cfg.url;
    this.extraHeaders = cfg.extraHeaders ?? {};
  }

  async chat(model: string, apiKey: string, req: ChatRequest): Promise<ChatResponse> {
    const wireMessages = toWireMessages(req);
    // OpenAI's newer models (gpt-5, o-series) reject `max_tokens` and require
    // `max_completion_tokens`. MiniMax and DeepSeek still use the legacy name.
    const tokenLimitKey = this.id === 'openai' ? 'max_completion_tokens' : 'max_tokens';
    const body: Record<string, unknown> = {
      model,
      messages: wireMessages,
      [tokenLimitKey]: req.maxOutputTokens ?? 1024,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.tools && req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
    }

    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...this.extraHeaders,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`http ${res.status}: ${text.slice(0, 500)}`);
    }
    let parsed: OpenAiResponseWire;
    try {
      parsed = JSON.parse(text) as OpenAiResponseWire;
    } catch {
      throw new Error('malformed openai-compat response');
    }
    if (parsed.error?.message) throw new Error(parsed.error.message);

    const choice = parsed.choices?.[0];
    const msg = choice?.message;
    const replyText = typeof msg?.content === 'string' ? msg.content : '';
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: safeParseObj(tc.function.arguments),
    }));

    const inTok = parsed.usage?.prompt_tokens ?? 0;
    const outTok = parsed.usage?.completion_tokens ?? 0;
    const m = findModel(model);
    const costUsd = m
      ? (inTok * m.pricePerMInput + outTok * m.pricePerMOutput) / 1_000_000
      : 0;

    return {
      text: replyText,
      toolCalls,
      stopReason: mapStopReason(choice?.finish_reason, toolCalls.length > 0),
      usage: { inTokens: inTok, outTokens: outTok, costUsd },
      modelId: parsed.model ?? model,
      rawForLog: text.slice(0, 2000),
    };
  }
}

function mapStopReason(raw: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || raw === 'tool_calls') return 'tool_use';
  if (raw === 'length') return 'length';
  if (raw === 'stop' || raw === 'end_turn') return 'end';
  return 'end';
}

function safeParseObj(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Convert our normalized ChatMessage[] to the OpenAI wire format.
 *
 * - system: pulled from req.system (prepended)
 * - assistant with toolCalls: tool_calls field set, content = ''
 * - tool result: role='tool', tool_call_id = toolResultFor
 */
function toWireMessages(req: ChatRequest): OpenAiMessageWire[] {
  const out: OpenAiMessageWire[] = [];
  if (req.system) out.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    out.push(messageToWire(m));
  }
  return out;
}

function messageToWire(m: ChatMessage): OpenAiMessageWire {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolResultFor ?? '', content: m.content };
  }
  if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  return { role: m.role as 'system' | 'user' | 'assistant', content: m.content };
}
