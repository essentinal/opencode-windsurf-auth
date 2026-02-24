#!/usr/bin/env bun
/**
 * Windsurf proxy daemon — spawned as a detached background process by plugin.ts.
 * Runs persistently so it outlives any individual OpenCode invocation.
 *
 * Direct usage:
 *   bun run src/server.ts
 */

import { isWindsurfRunning, getCredentials } from './plugin/auth.js';
import { getCanonicalModels, getModelVariants } from './plugin/models.js';
import {
  openAIError,
  createStreamingResponse,
  createNonStreamingResponse,
  handleToolPlanning,
  handleToolPlanningStream,
} from './plugin.js';

const HOST = '127.0.0.1';
const PORT = 42100;

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return new Response(
        JSON.stringify({ ok: true, windsurf: isWindsurfRunning() }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/v1/models' || url.pathname === '/models') {
      const models = getCanonicalModels();
      return new Response(
        JSON.stringify({
          object: 'list',
          data: models.map((id) => {
            const variants = getModelVariants(id);
            return {
              id,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'windsurf',
              ...(variants
                ? {
                    variants: Object.entries(variants).map(([name, meta]) => ({
                      id: name,
                      description: (meta as any).description,
                    })),
                  }
                : {}),
            };
          }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions') {
      if (!isWindsurfRunning()) {
        return openAIError(503, 'Windsurf is not running. Please launch Windsurf first.');
      }

      try {
        const credentials = getCredentials();
        const body = await req.json().catch(() => ({}));
        const requestBody = body as any;
        const isStreaming = requestBody.stream === true;

        const hasToolsField = Array.isArray(requestBody.tools) && requestBody.tools.length > 0;
        const hasToolMessages = requestBody.messages?.some(
          (m: any) =>
            m.role === 'tool' ||
            (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)
        );

        if (hasToolsField || hasToolMessages) {
          if (isStreaming) {
            const stream = handleToolPlanningStream(credentials, requestBody);
            return new Response(stream, {
              status: 200,
              headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
            });
          }
          return await handleToolPlanning(credentials, requestBody);
        }

        if (isStreaming) {
          const stream = createStreamingResponse(credentials, requestBody);
          return new Response(stream, {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
          });
        }

        const responseData = await createNonStreamingResponse(credentials, requestBody);
        return new Response(JSON.stringify(responseData), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return openAIError(500, 'Chat completion failed', msg);
      }
    }

    return openAIError(404, `Unsupported path: ${url.pathname}`);
  },
});

console.log(`Windsurf proxy listening on http://${HOST}:${server.port}/v1`);
