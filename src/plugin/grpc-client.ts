/**
 * gRPC Client for Windsurf Language Server
 *
 * Implements the Cascade session flow:
 *   1. StartCascade → get cascadeId
 *   2. SendUserCascadeMessage → trigger cloud inference
 *   3. Poll GetCascadeTrajectorySteps → extract planner_response text
 *
 * Note: StreamCascadeReactiveUpdates only works for IDE's own webview.
 * External clients must use GetCascadeTrajectorySteps polling instead.
 *
 * Uses manual protobuf encoding (no external protobuf library needed).
 */

import * as http2 from 'http2';
import * as crypto from 'crypto';
import * as zlib from 'zlib';
import * as os from 'os';
import { resolveModel, enumToProtoName } from './models.js';
import { WindsurfCredentials, WindsurfError, WindsurfErrorCode } from './auth.js';

// ============================================================================
// Types
// ============================================================================

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  onChunk?: (text: string) => void;
  onComplete?: (fullText: string) => void;
  onError?: (error: Error) => void;
  variantOverride?: string;
}

const GRPC_METHODS = {
  startCascade: '/exa.language_server_pb.LanguageServerService/StartCascade',
  sendUserCascadeMessage: '/exa.language_server_pb.LanguageServerService/SendUserCascadeMessage',
  getCascadeTrajectorySteps: '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectorySteps',
};

// ============================================================================
// Protobuf Encoding Helpers
// ============================================================================

/**
 * Encode a number as a varint (variable-length integer)
 */
function encodeVarint(value: number | bigint): number[] {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v > 127n) {
    bytes.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  bytes.push(Number(v));
  return bytes;
}

/**
 * Encode a string field (wire type 2: length-delimited)
 */
function encodeString(fieldNum: number, str: string): number[] {
  const strBytes = Buffer.from(str, 'utf8');
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(strBytes.length), ...strBytes];
}

/**
 * Encode a nested message field (wire type 2: length-delimited)
 */
function encodeMessage(fieldNum: number, data: number[]): number[] {
  return [...encodeVarint((fieldNum << 3) | 2), ...encodeVarint(data.length), ...data];
}

/**
 * Encode a varint field (wire type 0)
 */
function encodeVarintField(fieldNum: number, value: number | bigint): number[] {
  return [...encodeVarint((fieldNum << 3) | 0), ...encodeVarint(value)];
}

// ============================================================================
// Request Building
// ============================================================================

/**
 * Encode CascadeConfig required by SendUserCascadeMessage.
 * Without this field the LS panics: "invalid value: merging into nil message".
 *
 * CascadeConfig (field 1 = planner_config):
 *   CascadePlannerConfig:
 *     field 2  = conversational (CascadeConversationalPlannerConfig, empty)
 *     field 35 = requested_model_uid (string)
 */
function encodeCascadeConfig(modelUid: string): number[] {
  const conversational: number[] = []; // empty CascadeConversationalPlannerConfig
  const plannerConfig: number[] = [
    ...encodeMessage(2, conversational),
    ...(modelUid ? encodeString(35, modelUid) : []),
  ];
  return encodeMessage(1, plannerConfig);
}

/**
 * Build a gRPC frame: compression(0) + 4-byte BE length + payload.
 */
function makeGrpcFrame(bytes: number[]): Buffer {
  const payload = Buffer.from(bytes);
  const frame = Buffer.alloc(5 + payload.length);
  frame[0] = 0;
  frame.writeUInt32BE(payload.length, 1);
  payload.copy(frame, 5);
  return frame;
}

/**
 * StartCascadeRequest:
 *   field 1: metadata
 *   field 4: source uint32 = 3 (WINDSURF_CHAT)
 */
function buildStartCascadeRequest(metadata: number[]): Buffer {
  return makeGrpcFrame([
    ...encodeMessage(1, metadata),
    ...encodeVarintField(4, 3),
  ]);
}

/**
 * SendUserCascadeMessageRequest:
 *   field 1: cascade_id (string)
 *   field 2: items (TextOrScopeItem — field 1 = text string)
 *   field 3: metadata
 *   field 5: cascade_config (required)
 */
function buildSendUserCascadeMessageRequest(
  cascadeId: string,
  messages: ChatMessage[],
  metadata: number[],
  modelUid: string,
): Buffer {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') systemParts.push(msg.content);
    else if (msg.role === 'user') userParts.push(msg.content);
  }
  const text = [...systemParts, ...userParts].join('\n\n') || 'Hello';

  return makeGrpcFrame([
    ...encodeString(1, cascadeId),
    ...encodeMessage(2, encodeString(1, text)), // TextOrScopeItem.text
    ...encodeMessage(3, metadata),
    ...encodeMessage(5, encodeCascadeConfig(modelUid)),
  ]);
}

/**
 * StreamCascadeReactiveUpdatesRequest:
 *   field 1: protocol_version uint32 = 1
 *   field 2: id (cascade_id string)
 */
function buildStreamRequest(cascadeId: string): Buffer {
  return makeGrpcFrame([
    ...encodeVarintField(1, 1),
    ...encodeString(2, cascadeId),
  ]);
}

/**
 * Build the metadata message for the request
 * 
 * Metadata structure:
 * Field 1: ide_name (string)
 * Field 2: extension_version (string)
 * Field 3: api_key (string, required)
 * Field 4: locale (string)
 * Field 7: ide_version (string)
 * Field 12: extension_name (string)
 */
import { getMetadataFields } from './discovery.js';

// Per-proxy session ID (stable within a proxy process lifetime, like the official extension)
const PROXY_SESSION_ID = crypto.randomUUID();
let requestCounter = 0;

/**
 * Compute device fingerprint matching extension.js generateFingerprint():
 * sha256(sorted(macs).join(",") + "," + serial + "," + username)
 */
function computeDeviceFingerprint(): string {
  try {
    const ifaces = os.networkInterfaces();
    const macs: string[] = [];
    for (const addrs of Object.values(ifaces)) {
      for (const addr of (addrs ?? [])) {
        if (addr.mac && addr.mac !== '00:00:00:00:00:00') macs.push(addr.mac);
      }
    }
    const uniqueMacs = [...new Set(macs)].sort();
    const username = os.userInfo().username;
    const n = { macs: uniqueMacs.join(','), serial: '', username };
    const input = Object.keys(n).sort().map(k => (n as Record<string, string>)[k]).join(',');
    return crypto.createHash('sha256').update(input).digest('hex');
  } catch {
    return '';
  }
}

const DEVICE_FINGERPRINT = computeDeviceFingerprint();

/**
 * Build the metadata message for the request
 * Dynamically maps fields using discovered extension.js values.
 * Field numbers from extension.js MetadataProvider:
 *   1=ide_name, 2=extension_version, 3=api_key, 4=locale, 5=os,
 *   7=ide_version, 9=request_id, 10=session_id, 12=extension_name,
 *   24=device_fingerprint, 28=ide_type
 */
function encodeMetadata(apiKey: string, version: string): number[] {
  const fields = getMetadataFields();
  requestCounter++;

  const os = process.platform === 'darwin' ? 'macos'
    : process.platform === 'win32' ? 'windows'
    : 'linux';

  const meta = [
    ...encodeString(fields.api_key, apiKey),                         // api_key (3)
    ...encodeString(fields.ide_name, 'windsurf'),                    // ide_name (1)
    ...encodeString(fields.ide_version, version),                    // ide_version (7)
    ...encodeString(fields.extension_version, version),              // extension_version (2)
    ...encodeString(fields.session_id, PROXY_SESSION_ID),            // session_id (10)
    ...encodeString(fields.locale, 'en'),                            // locale (4)
    ...encodeString(12, 'windsurf'),                                 // extension_name (12)
    ...encodeString(5, os),                                          // os (5)
    ...encodeVarintField(9, requestCounter),                         // request_id (9)
  ];

  if (DEVICE_FINGERPRINT) {
    meta.push(...encodeString(24, DEVICE_FINGERPRINT));              // device_fingerprint (24)
  }

  return meta;
}


// ============================================================================
// Response Parsing (GetCascadeTrajectorySteps polling)
// ============================================================================

/**
 * Decompress a gRPC frame if needed (compression flag = 1 → gzip).
 */
function decompressFrame(comp: number, data: Buffer): Buffer {
  if (comp === 1) {
    try { return zlib.gunzipSync(data); } catch { return data; }
  }
  return data;
}

type ProtoField = { field: number; wire: number; value: Buffer | bigint };

/**
 * Parse top-level protobuf fields from a buffer.
 */
function parseProtoFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let p = 0;
  while (p < buf.length) {
    let tag = 0, shift = 0, start = p;
    while (p < buf.length) { const b = buf[p++]; tag |= (b & 0x7f) << shift; shift += 7; if (!(b & 0x80)) break; }
    if (p === start) break;
    const wire = tag & 7, field = tag >> 3;
    if (wire === 2) {
      let l = 0, sh = 0;
      while (p < buf.length) { const b = buf[p++]; l |= (b & 0x7f) << sh; sh += 7; if (!(b & 0x80)) break; }
      if (p + l > buf.length) break;
      fields.push({ field, wire, value: buf.subarray(p, p + l) }); p += l;
    } else if (wire === 0) {
      let v = 0n, sh = 0n;
      while (p < buf.length) { const b = buf[p++]; v |= BigInt(b & 0x7f) << sh; sh += 7n; if (!(b & 0x80)) break; }
      fields.push({ field, wire, value: v });
    } else if (wire === 1) { fields.push({ field, wire, value: buf.subarray(p, p + 8) }); p += 8; }
    else if (wire === 5) { fields.push({ field, wire, value: buf.subarray(p, p + 4) }); p += 4; }
    else break;
  }
  return fields;
}

/**
 * Decode all gRPC frames from a response buffer, decompressing as needed.
 */
function decodeGrpcFrames(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let pos = 0;
  while (pos + 5 <= buf.length) {
    const comp = buf[pos];
    const flen = buf.readUInt32BE(pos + 1);
    if (pos + 5 + flen > buf.length) break;
    out.push(decompressFrame(comp, buf.subarray(pos + 5, pos + 5 + flen)));
    pos += 5 + flen;
  }
  return out;
}

/**
 * Extract cascade_id from a StartCascadeResponse frame (field 1 = cascade_id).
 */
function extractCascadeId(data: Buffer): string {
  for (const f of parseProtoFields(data)) {
    if (f.field === 1 && Buffer.isBuffer(f.value)) return f.value.toString('utf8');
  }
  return '';
}

/**
 * Extract planner_response text from GetCascadeTrajectoryStepsResponse.
 *
 * Response structure:
 *   GetCascadeTrajectoryStepsResponse
 *     field 1 (repeated): CortexTrajectoryStep
 *       field 20 (oneof "step"): CortexStepPlannerResponse
 *         field 1: response (string)   ← the AI text
 *         field 8: modified_response (string)
 *
 * Returns the last non-empty planner_response text found, or '' if none.
 */
function extractPlannerResponse(buf: Buffer): string {
  let result = '';
  for (const frame of decodeGrpcFrames(buf)) {
    for (const f1 of parseProtoFields(frame)) {
      if (f1.field !== 1 || !Buffer.isBuffer(f1.value)) continue; // steps[]
      for (const f2 of parseProtoFields(f1.value)) {
        if (f2.field !== 20 || !Buffer.isBuffer(f2.value)) continue; // planner_response
        for (const f3 of parseProtoFields(f2.value)) {
          if (Buffer.isBuffer(f3.value)) {
            if (f3.field === 1) { // response
              const t = f3.value.toString('utf8');
              if (t) result = t;
            }
            if (f3.field === 8) { // modified_response (overrides response)
              const t = f3.value.toString('utf8');
              if (t) result = t;
            }
          }
        }
      }
    }
  }
  return result;
}

// ============================================================================
// Low-level gRPC helpers
// ============================================================================

const GRPC_HEADERS = (csrfToken: string) => ({
  ':method': 'POST',
  'content-type': 'application/grpc',
  'te': 'trailers',
  'grpc-accept-encoding': 'identity,gzip',
  'x-codeium-csrf-token': csrfToken,
});

function newClient(port: number): http2.ClientHttp2Session {
  return http2.connect(`http://127.0.0.1:${port}`);
}

/**
 * Perform a unary gRPC call and return the full response buffer + grpc-status.
 */
async function grpcUnary(
  port: number,
  csrfToken: string,
  path: string,
  body: Buffer,
): Promise<{ buf: Buffer; status: string; message: string }> {
  return new Promise((resolve, reject) => {
    const client = newClient(port);
    client.on('error', (e) => reject(e));
    const r = client.request({ ...GRPC_HEADERS(csrfToken), ':path': path });
    let buf = Buffer.alloc(0);
    let status = '0', message = '';
    r.on('response', () => {});
    r.on('data', (c: Buffer) => { buf = Buffer.concat([buf, c]); });
    r.on('trailers', (t) => {
      status = String(t['grpc-status'] ?? '0');
      message = decodeURIComponent(String(t['grpc-message'] ?? ''));
    });
    r.on('end', () => { client.close(); resolve({ buf, status, message }); });
    r.on('error', (e) => { client.close(); reject(e); });
    r.write(body);
    r.end();
  });
}

// ============================================================================
// Cascade API
// ============================================================================

const POLL_INTERVAL_MS = 1_500;
const POLL_MAX_ATTEMPTS = 60; // 90s total

/**
 * Execute the full Cascade session flow using polling:
 *   1. StartCascade (unary) → cascadeId
 *   2. SendUserCascadeMessage (unary) → triggers cloud inference
 *   3. Poll GetCascadeTrajectorySteps until planner_response appears
 *
 * Note: StreamCascadeReactiveUpdates only works for the IDE's own webview
 * subscriptions. External processes must poll via GetCascadeTrajectorySteps.
 *
 * Response proto path:
 *   GetCascadeTrajectoryStepsResponse
 *     .steps[] (field 1, CortexTrajectoryStep)
 *       .planner_response (field 20, CortexStepPlannerResponse)
 *         .response (field 1, string)  ← the AI text
 */
export async function* streamChatGenerator(
  credentials: WindsurfCredentials,
  options: Pick<StreamChatOptions, 'model' | 'messages'>
): AsyncGenerator<string, void, unknown> {
  const { csrfToken, port, apiKey, version } = credentials;
  const resolved = resolveModel(options.model);
  const modelUid = resolved.modelUid ?? enumToProtoName(resolved.enumValue);
  const metadata = encodeMetadata(apiKey, version);

  // ── Step 1: StartCascade ──────────────────────────────────────────────────
  const startRes = await grpcUnary(
    port, csrfToken,
    GRPC_METHODS.startCascade,
    buildStartCascadeRequest(metadata),
  ).catch((e) => { throw new WindsurfError(`StartCascade failed: ${e.message}`, WindsurfErrorCode.CONNECTION_FAILED, e); });

  if (startRes.status !== '0') {
    throw new WindsurfError(
      `StartCascade gRPC error ${startRes.status}: ${startRes.message}`,
      WindsurfErrorCode.STREAM_ERROR,
    );
  }

  let cascadeId = '';
  for (const frame of decodeGrpcFrames(startRes.buf)) {
    const id = extractCascadeId(frame);
    if (id) { cascadeId = id; break; }
  }
  if (!cascadeId) {
    throw new WindsurfError('StartCascade returned no cascadeId', WindsurfErrorCode.STREAM_ERROR);
  }

  // ── Step 2: SendUserCascadeMessage ────────────────────────────────────────
  const sendRes = await grpcUnary(
    port, csrfToken,
    GRPC_METHODS.sendUserCascadeMessage,
    buildSendUserCascadeMessageRequest(cascadeId, options.messages, metadata, modelUid),
  ).catch((e) => { throw new WindsurfError(`SendUserCascadeMessage failed: ${e.message}`, WindsurfErrorCode.STREAM_ERROR, e); });

  if (sendRes.status !== '0') {
    throw new WindsurfError(
      `SendUserCascadeMessage gRPC error ${sendRes.status}: ${sendRes.message}`,
      WindsurfErrorCode.STREAM_ERROR,
    );
  }

  // ── Step 3: Poll GetCascadeTrajectorySteps ────────────────────────────────
  const pollBody = makeGrpcFrame([
    ...encodeString(1, cascadeId),
    ...encodeVarintField(2, 0), // step_offset = 0
  ]);

  for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));

    const pollRes = await grpcUnary(
      port, csrfToken,
      GRPC_METHODS.getCascadeTrajectorySteps,
      pollBody,
    ).catch(() => null);

    if (!pollRes || pollRes.status !== '0') continue;

    const text = extractPlannerResponse(pollRes.buf);
    if (text) {
      yield text;
      return;
    }
  }

  throw new WindsurfError(
    `GetCascadeTrajectorySteps: no planner_response after ${POLL_MAX_ATTEMPTS} attempts`,
    WindsurfErrorCode.STREAM_ERROR,
  );
}

/**
 * Promise-based wrapper around streamChatGenerator for non-streaming callers.
 */
export async function streamChat(
  credentials: WindsurfCredentials,
  options: StreamChatOptions,
): Promise<string> {
  const chunks: string[] = [];
  try {
    for await (const chunk of streamChatGenerator(credentials, options)) {
      chunks.push(chunk);
      options.onChunk?.(chunk);
    }
  } catch (e) {
    options.onError?.(e as Error);
    throw e;
  }
  const fullText = chunks.join('');
  options.onComplete?.(fullText);
  return fullText;
}
