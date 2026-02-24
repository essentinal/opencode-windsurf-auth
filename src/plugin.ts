/**
 * Windsurf Plugin for OpenCode
 * 
 * Enables using Windsurf/Codeium models through OpenCode by intercepting
 * requests and routing them through the local Windsurf language server.
 * 
 * Architecture:
 * 1. Plugin registers a custom fetch handler for windsurf.local domain
 * 2. Requests are transformed to gRPC format and sent to local language server
 * 3. Responses are streamed back in OpenAI-compatible SSE format
 * 
 * Requirements:
 * - Windsurf must be running (launches language_server_macos process)
 * - User must be logged into Windsurf (provides API key in ~/.codeium/config.json)
 */

import * as crypto from 'crypto';
import * as _childProcess from 'child_process';
import * as _path from 'path';
import * as _fs from 'fs';
import type { PluginInput, Hooks } from '@opencode-ai/plugin';
import { WindsurfCredentials } from './plugin/auth.js';
import { streamChatGenerator, ChatMessage } from './plugin/grpc-client.js';
import {
  getDefaultModel,
  resolveModel,
} from './plugin/models.js';
import { PLUGIN_ID } from './constants.js';

// ============================================================================
// Types
// ============================================================================

interface ChatCompletionRequest {
  model?: string;
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string }>;
  }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{
    type?: string;
    function?: {
      name?: string;
      description?: string;
      parameters?: any;
    };
  }>;
  providerOptions?: Record<string, unknown>;
}

function extractVariantFromProviderOptions(providerOptions: Record<string, unknown> | undefined): string | undefined {
  if (!providerOptions) return undefined;
  const windsurf = (providerOptions as any).windsurf as Record<string, unknown> | undefined;
  const candidate =
    (windsurf?.variant as string | undefined) ??
    (windsurf?.variantID as string | undefined) ??
    (windsurf?.variantId as string | undefined) ??
    (providerOptions as any).variant ??
    (providerOptions as any).variantID ??
    (providerOptions as any).variantId;
  if (candidate && typeof candidate === 'string') return candidate;
  return undefined;
}

async function runWindsurfOnce(
  credentials: WindsurfCredentials,
  model: string,
  prompt: string
): Promise<string> {
  const chunks: string[] = [];
  const generator = streamChatGenerator(credentials, {
    model,
    messages: [{ role: 'user', content: prompt }],
  });
  for await (const chunk of generator) {
    chunks.push(chunk);
  }
  return chunks.join('');
}

async function planToolCall(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): Promise<{ plan: ToolCallPlan | null; content: string; model: string }> {
  const model = request.model || getDefaultModel();
  const prompt = buildToolPrompt(request);
  const content = await runWindsurfOnce(credentials, model, prompt);
  const plan = parseToolCallPlan(content);
  return { plan, content, model };
}

function buildToolCallPayload(model: string, toolCalls: Array<{ name: string; arguments: any }>) {
  const mapped = toolCalls.map((tc, i) => ({
    id: `call_${Date.now()}_${i}`,
    type: 'function',
    function: {
      name: tc.name,
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  }));

  return {
    id: `windsurf-tools-${Date.now()}`,
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant' as const,
          content: '',
          tool_calls: mapped,
        },
        finish_reason: 'tool_calls' as const,
      },
    ],
  };
}

export async function handleToolPlanning(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): Promise<Response> {
  const { plan, content, model } = await planToolCall(credentials, request);

  if (plan?.action === 'tool_call') {
    const payload = buildToolCallPayload(model, plan.tool_calls);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const finalContent = plan?.action === 'final' ? plan.content : content;
  const payload = {
    id: `windsurf-tools-${Date.now()}`,
    object: 'chat.completion' as const,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant' as const, content: finalContent },
        finish_reason: 'stop' as const,
      },
    ],
  };

  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function handleToolPlanningStream(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      try {
        const { plan, content, model } = await planToolCall(credentials, request);
        const id = `windsurf-tools-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);

        if (plan?.action === 'tool_call') {
          const mapped = plan.tool_calls.map((tc, i) => ({
            index: i,
            id: `call_${Date.now()}_${i}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments ?? {}),
            },
          }));

          const chunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: mapped,
                },
                finish_reason: 'tool_calls' as const,
              },
            ],
          };

          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
          return;
        }

        const finalContent = plan?.action === 'final' ? plan.content : content;
        const finalChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: { content: finalContent },
              finish_reason: 'stop' as const,
            },
          ],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: { message: msg } })}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });
}

interface ChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { content?: string; role?: string };
    finish_reason: string | null;
  }>;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
}

// ============================================================================
// Response Helpers
// ============================================================================

type ToolDef = NonNullable<ChatCompletionRequest['tools']>[number];

function summarizeTool(tool: ToolDef): string {
  const name = tool?.function?.name || 'unknown';
  const description = tool?.function?.description || '';
  const params = tool?.function?.parameters;

  let paramsSummary = '';
  if (params && typeof params === 'object') {
    try {
      paramsSummary = `schema:\n${JSON.stringify(params, null, 2)}`;
    } catch {
      paramsSummary = `schema: ${String(params)}`;
    }
  }

  const lines = [`- ${name}${description ? `: ${description}` : ''}`];
  if (paramsSummary) {
    lines.push(paramsSummary);
  }
  return lines.join('\n');
}

function extractTextParts(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.map((p) => (p?.type === 'text' && p.text ? p.text : '')).filter(Boolean).join('\n');
}

function buildToolPrompt(request: ChatCompletionRequest): string {
  const tools = Array.isArray(request.tools) ? request.tools : [];
  const toolList = tools.length ? tools.map(summarizeTool).join('\n') : '(none)';

  const systemMessages = request.messages.filter((m) => m.role === 'system');
  const systemText = systemMessages.map((m) => extractTextParts(m.content)).filter(Boolean).join('\n\n');

  const conversationLines: string[] = [];
  for (const message of request.messages) {
    const role = message.role || 'user';
    if (role === 'system') continue; // already aggregated
    if (role === 'tool') {
      const content = extractTextParts(message.content);
      const name = (message as any).name || 'tool';
      const toolCallId = (message as any).tool_call_id;
      conversationLines.push(`TOOL RESULT (${name}${toolCallId ? `, id=${toolCallId}` : ''}): ${content}`);
      continue;
    }
    if (role === 'assistant' && Array.isArray((message as any).tool_calls)) {
      conversationLines.push(`ASSISTANT TOOL_CALLS: ${JSON.stringify((message as any).tool_calls)}`);
      continue;
    }
    const content = extractTextParts(message.content);
    if (content) {
      conversationLines.push(`${role.toUpperCase()}: ${content}`);
    }
  }

  return [
    'You are a tool-calling assistant running inside OpenCode.',
    systemText ? `System: ${systemText}` : '',
    '',
    'Available tools:',
    toolList,
    '',
    'STRICT OUTPUT:',
    '- Output MUST be exactly one JSON object and nothing else.',
    '- If you output anything outside JSON, your answer is discarded.',
    '- DO NOT emit <tool_call> tags or prose. Only JSON.',
    '- Arguments MUST follow each tool\'s JSON schema exactly (types, nesting, required fields).',
    '',
    'RESPONSE FORMAT:',
    '- Call tool(s):',
    '{"action":"tool_call","tool_calls":[{"name":"tool_name","arguments":{"arg":"value"}}]}',
    '- Final answer:',
    '{"action":"final","content":"..."}',
    '',
    'Conversation:',
    conversationLines.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

type ToolCallPlan =
  | { action: 'final'; content: string }
  | { action: 'tool_call'; tool_calls: Array<{ name: string; arguments: any }> };

function normalizeToolArguments(raw: any): any {
  if (raw == null) return {};

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const looksJson =
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'));
    if (looksJson) {
      try {
        return normalizeToolArguments(JSON.parse(trimmed));
      } catch {
        return raw;
      }
    }
    return raw;
  }

  if (Array.isArray(raw)) {
    return raw.map((item) => normalizeToolArguments(item));
  }

  if (typeof raw === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(raw)) {
      result[key] = normalizeToolArguments(value);
    }
    return result;
  }

  return raw;
}

function parseToolCallPlan(output: string): ToolCallPlan | null {
  const start = output.indexOf('{');
  const end = output.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  const jsonText = output.slice(start, end + 1);
  try {
    const parsed = JSON.parse(jsonText);
    if (parsed && parsed.action === 'final' && typeof parsed.content === 'string') {
      return { action: 'final', content: parsed.content };
    }
    if (parsed && parsed.action === 'tool_call' && Array.isArray(parsed.tool_calls)) {
      return {
        action: 'tool_call',
        tool_calls: parsed.tool_calls
          .filter((t: any) => t && typeof t.name === 'string')
          .map((t: any) => ({ name: t.name, arguments: normalizeToolArguments(t.arguments) })),
      };
    }
    return null;
  } catch {
    // heuristic: look for one or more <tool_call>name {json}
    const matches = [...output.matchAll(/<tool_call>\s*([\w.-]+)\s*(\{[\s\S]*?\})(?=\s*(?:<tool_call>|$))/g)];
    if (matches.length === 0) {
      return null;
    }

    const tool_calls = matches
      .map((match) => {
        const name = match[1];
        const rawArgs = match[2];
        try {
          const args = JSON.parse(rawArgs);
          return { name, arguments: normalizeToolArguments(args) };
        } catch {
          return null;
        }
      })
      .filter((tc): tc is { name: string; arguments: any } => Boolean(tc));

    if (tool_calls.length === 0) {
      return null;
    }

    return { action: 'tool_call', tool_calls };
  }
}

/**
 * Create an OpenAI-compatible response object
 */
function createOpenAICompatibleResponse(
  id: string,
  model: string,
  content: string,
  isStreaming: boolean,
  finishReason: string | null = null
): ChatCompletionChunk | ChatCompletionResponse {
  const timestamp = Math.floor(Date.now() / 1000);

  if (isStreaming) {
    return {
      id,
      object: 'chat.completion.chunk',
      created: timestamp,
      model,
      choices: [
        {
          index: 0,
          delta: { content },
          finish_reason: finishReason,
        },
      ],
    };
  }

  return {
    id,
    object: 'chat.completion',
    created: timestamp,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: finishReason || 'stop',
      },
    ],
  };
}

/**
 * Create a streaming response using the gRPC generator
 */
export function createStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);
  const resolved = resolveModel(requestedModel, variantOverride);
  const effectiveModel = resolved.variant
    ? `${resolved.modelId}:${resolved.variant}`
    : resolved.modelId;

  return new ReadableStream({
    async start(controller) {
      try {
        // Convert messages to the format expected by gRPC client
        const messages: ChatMessage[] = request.messages
          .filter((m) => m.role !== 'assistant' && m.role !== 'tool')
          .map((m) => ({
            role: m.role as ChatMessage['role'],
            content:
              typeof m.content === 'string'
                ? m.content
                : m.content.map((p) => p.text || '').join(''),
          }));

        const generator = streamChatGenerator(credentials, {
          model: effectiveModel,
          messages,
        });

        for await (const chunk of generator) {
          const responseChunk = createOpenAICompatibleResponse(
            responseId,
            requestedModel,
            chunk,
            true
          );
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(responseChunk)}\n\n`)
          );
        }

        // Send final chunk with finish_reason
        const finalChunk = createOpenAICompatibleResponse(
          responseId,
          requestedModel,
          '',
          true,
          'stop'
        );
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`)
        );

        // Send [DONE] marker
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({ error: { message: errorMessage } })}\n\n`
          )
        );
        controller.close();
      }
    },
  });
}

/**
 * Create a non-streaming response by collecting all chunks
 */
export async function createNonStreamingResponse(
  credentials: WindsurfCredentials,
  request: ChatCompletionRequest
): Promise<ChatCompletionResponse> {
  const responseId = `chatcmpl-${crypto.randomUUID()}`;
  const requestedModel = request.model || getDefaultModel();
  const variantOverride = extractVariantFromProviderOptions(request.providerOptions);
  const resolved = resolveModel(requestedModel, variantOverride);
  const effectiveModel = resolved.variant
    ? `${resolved.modelId}:${resolved.variant}`
    : resolved.modelId;
  const chunks: string[] = [];

  // Convert messages
  const messages: ChatMessage[] = request.messages
    .filter((m) => m.role !== 'assistant' && m.role !== 'tool')
    .map((m) => ({
      role: m.role as ChatMessage['role'],
      content:
        typeof m.content === 'string'
          ? m.content
          : m.content.map((p) => p.text || '').join(''),
    }));

  const generator = streamChatGenerator(credentials, {
    model: effectiveModel,
    messages,
  });

  for await (const chunk of generator) {
    chunks.push(chunk);
  }

  const fullContent = chunks.join('');
  return createOpenAICompatibleResponse(
    responseId,
    requestedModel,
    fullContent,
    false,
    'stop'
  ) as ChatCompletionResponse;
}

// ============================================================================
// Local Proxy Server (like cursor-auth pattern)
// ============================================================================

const WINDSURF_PROXY_HOST = '127.0.0.1';
const WINDSURF_PROXY_DEFAULT_PORT = 42100;

export function openAIError(status: number, message: string, details?: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: details ? `${message}\n${details}` : message,
        type: 'windsurf_error',
        param: null,
        code: null,
      },
    }),
    { status, headers: { 'Content-Type': 'application/json' } }
  );
}

/**
 * Spawn the proxy as a detached background process so it outlives OpenCode.
 * Uses the compiled dist/server.js entry point via the bun binary.
 */
function spawnProxyDaemon(): void {
  // Use Node builtins directly via ESM import (pre-imported at module level)
  const { spawn } = _childProcess;
  const path = _path;
  const fs = _fs;

  // Find bun executable
  let bunBin = 'bun';
  const bunCandidates = [
    process.env.HOME ? `${process.env.HOME}/.bun/bin/bun` : null,
    '/usr/local/bin/bun',
    '/usr/bin/bun',
  ].filter(Boolean) as string[];
  for (const candidate of bunCandidates) {
    if (fs.existsSync(candidate)) { bunBin = candidate; break; }
  }

  // Resolve the server entry point relative to this file
  const serverEntry = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    'server.js'
  );

  if (!fs.existsSync(serverEntry)) return;

  const child = spawn(bunBin, [serverEntry], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();
}

export async function ensureWindsurfProxyServer(): Promise<string> {
  const baseURL = `http://${WINDSURF_PROXY_HOST}:${WINDSURF_PROXY_DEFAULT_PORT}/v1`;

  // If proxy already up, return immediately
  try {
    const res = await fetch(`http://${WINDSURF_PROXY_HOST}:${WINDSURF_PROXY_DEFAULT_PORT}/health`).catch(() => null);
    if (res && res.ok) return baseURL;
  } catch {
    // ignore
  }

  // Spawn persistent proxy daemon and wait for it to come up (up to 5s)
  spawnProxyDaemon();

  for (let i = 0; i < 25; i++) {
    await new Promise(r => setTimeout(r, 200));
    try {
      const res = await fetch(`http://${WINDSURF_PROXY_HOST}:${WINDSURF_PROXY_DEFAULT_PORT}/health`).catch(() => null);
      if (res && res.ok) return baseURL;
    } catch {
      // keep waiting
    }
  }

  // Return the URL anyway — it may still be starting up
  return baseURL;
}

// ============================================================================
// Eager proxy startup — begins at module load time so the server is ready
// before OpenCode invokes the plugin factory asynchronously.
// ============================================================================

void ensureWindsurfProxyServer().catch(() => {
  // Swallow startup errors here; they will surface when the factory awaits
});

// ============================================================================
// Plugin Factory
// ============================================================================

/**
 * Create the Windsurf plugin (follows cursor-auth pattern)
 */
export const createWindsurfPlugin =
  (providerId: string = PLUGIN_ID) =>
  async (_context: PluginInput): Promise<Hooks> => {
    // Await the eagerly-started proxy (may already be resolved)
    const proxyBaseURL = await ensureWindsurfProxyServer();

    return {
      auth: {
        provider: providerId,

        async loader(_getAuth: () => Promise<unknown>) {
          return {};
        },

        methods: [],
      },

      async 'chat.params'(input: any, output: any) {
        if (input.model?.providerID !== providerId) {
          return;
        }

        output.options = output.options || {};
        output.options.baseURL = proxyBaseURL;
        output.options.apiKey = output.options.apiKey || 'windsurf-local';
      },
    };
  };

/** Default Windsurf plugin export */
export const WindsurfPlugin = createWindsurfPlugin();

/** Alias for Codeium users */
export const CodeiumPlugin = createWindsurfPlugin('codeium');
