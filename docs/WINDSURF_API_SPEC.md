# Windsurf/Codeium API Specification

> **Note**: This specification is based on reverse-engineering of the Windsurf extension.
> It may be incomplete or change with Windsurf updates.
> Last updated: 2026-02-22

## Overview

Windsurf/Codeium uses a **gRPC** protocol with protobuf encoding to communicate with backend servers. The architecture involves:

1. **Local Language Server**: A Go binary (`language_server_macos`) that handles IDE operations and proxies inference
2. **Remote API Servers**: Cloud endpoints for inference and user management

The plugin communicates with the **local language server** via HTTP/2 gRPC on localhost.

## Endpoints

### Local Language Server

The language server listens on a **dynamic port** on localhost. The port is discovered via `lsof` on the process (see [REVERSE_ENGINEERING.md](REVERSE_ENGINEERING.md)).

### Remote Servers

| Server | URL | Purpose |
|--------|-----|---------|
| API Server | `https://server.codeium.com` | Main API operations |
| Inference Server | `https://inference.codeium.com` | Model inference |
| Registration | `https://register.windsurf.com` | User registration |
| Feature Flags | `https://unleash.codeium.com/api/` | Unleash feature flags |

### Regional Endpoints

| Region | URL |
|--------|-----|
| EU | `https://eu.windsurf.com/_route/api_server` |
| FedStart (Gov) | `https://windsurf.fedstart.com/_route/api_server` |
| Enterprise | `https://{tenant}.windsurf.com/_route/api_server` |

## Authentication

### Firebase Authentication

Windsurf uses Firebase Authentication with the following flow:

1. **Device Flow OAuth**
   - Call `StartDeviceFlow` gRPC method
   - Receive: `device_code`, `user_code`, `verification_url`
   - User visits URL and enters code
   - Poll `GetDeviceFlowState` until completion
   - Receive Firebase ID token

2. **Token Format**
   - Firebase ID Token (JWT)
   - Contains: `sub` (user ID), `email`, `exp`, `iat`
   - Expiry: Typically 1 hour

3. **Token Refresh**
   ```
   POST https://securetoken.googleapis.com/v1/token?key={FIREBASE_API_KEY}
   Content-Type: application/x-www-form-urlencoded
   
   grant_type=refresh_token&refresh_token={REFRESH_TOKEN}
   ```

### Local Language Server Authentication

The local language server uses a **CSRF token** passed via process arguments. No Firebase token is needed for local communication — the CSRF token authenticates the client.

```
x-codeium-csrf-token: {csrf_token from --csrf_token process arg}
```

### API Key

Stored in the VSCode state database:
```sql
-- ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';
-- Returns JSON: {"apiKey": "..."}
```

Legacy fallback: `~/.codeium/config.json` → `{"apiKey": "..."}`

### Request Metadata

Every gRPC request includes metadata (field numbers are dynamically discovered from extension.js):

```protobuf
message Metadata {
  string api_key = 1;           // User's API key from state.vscdb
  string ide_name = 2;          // "windsurf"
  string ide_version = 3;       // Version string from --windsurf_version
  string extension_version = 4; // Same as ide_version
  string session_id = 5;        // Random UUID per request
  string locale = 6;            // "en"
}
```

**Note**: Field numbers may change between Windsurf versions. The plugin's `discovery.ts` parses `extension.js` to find the current mapping.

## gRPC Services

### LanguageServerService (Local) — Primary

Runs on localhost, handles IDE operations and proxies inference.

```protobuf
service LanguageServerService {
  // Chat — THIS IS WHAT THE PLUGIN USES
  rpc RawGetChatMessage(RawGetChatMessageRequest) returns (stream RawGetChatMessageResponse);
  
  // Standard chat
  rpc GetChatMessage(GetChatMessageRequest) returns (GetChatMessageResponse);
  rpc SendUserCascadeMessage(SendUserCascadeMessageRequest) returns (SendUserCascadeMessageResponse);
  rpc StartCascade(StartCascadeRequest) returns (StartCascadeResponse);
  rpc StreamCascadeReactiveUpdates(StreamCascadeReactiveUpdatesRequest) returns (stream CascadeReactiveUpdate);
  
  // Completions
  rpc GetCompletions(GetCompletionsRequest) returns (GetCompletionsResponse);
  rpc GetStreamingCompletions(GetCompletionsRequest) returns (stream GetCompletionsResponse);
  
  // Auth
  rpc GetAuthToken(GetAuthTokenRequest) returns (GetAuthTokenResponse);
  rpc GetUserStatus(GetUserStatusRequest) returns (GetUserStatusResponse);
  rpc RegisterUser(RegisterUserRequest) returns (RegisterUserResponse);
  
  // Progress
  rpc ProgressBars(ProgressBarsRequest) returns (ProgressBarsResponse);
}
```

### ApiServerService (Remote)

Backend API for inference and management.

```protobuf
service ApiServerService {
  rpc GetChatMessage(GetChatMessageRequest) returns (GetChatMessageResponse);
  rpc GetChatCompletions(GetChatCompletionsRequest) returns (GetChatCompletionsResponse);
  rpc GetStreamingCompletions(GetStreamingCompletionsRequest) returns (stream CompletionChunk);
  rpc GetStreamingExternalChatCompletions(ExternalChatRequest) returns (stream ExternalChatChunk);
  rpc BatchRecordCompletions(BatchRecordCompletionsRequest) returns (BatchRecordCompletionsResponse);
  rpc RecordCortexTrajectory(RecordCortexTrajectoryRequest) returns (RecordCortexTrajectoryResponse);
  rpc CheckUserMessageRateLimit(CheckRateLimitRequest) returns (CheckRateLimitResponse);
  rpc GetCascadeModelConfigs(GetCascadeModelConfigsRequest) returns (GetCascadeModelConfigsResponse);
}
```

### ExtensionServerService

Extension-to-IDE bridge.

```protobuf
service ExtensionServerService {
  rpc StartDeviceFlow(StartDeviceFlowRequest) returns (StartDeviceFlowResponse);
  rpc GetDeviceFlowState(GetDeviceFlowStateRequest) returns (GetDeviceFlowStateResponse);
  rpc GetAuthToken(GetAuthTokenRequest) returns (GetAuthTokenResponse);
}
```

## Request/Response Formats

### RawGetChatMessageRequest (used by this plugin)

```protobuf
message RawGetChatMessageRequest {
  Metadata metadata = 1;
  repeated ChatMessage chat_messages = 2;
  string system_prompt_override = 3;   // System message content
  int32 chat_model = 4;               // Model enum value (varint)
  string chat_model_name = 5;         // Model name string (for variant fidelity)
}
```

### ChatMessage (used in RawGetChatMessageRequest)

```protobuf
message ChatMessage {
  string message_id = 1;              // UUID, required
  ChatMessageSource source = 2;       // Enum: 1=USER, 2=SYSTEM, 3=ASSISTANT, 4=TOOL
  google.protobuf.Timestamp timestamp = 3;  // Required
  string conversation_id = 4;         // UUID, required
  // Field 5 is overloaded by source type:
  //   USER/SYSTEM/TOOL: ChatMessageIntent (nested message)
  //   ASSISTANT: string (plain text)
  oneof content_field {
    ChatMessageIntent intent = 5;      // For USER/SYSTEM/TOOL
    string text = 5;                   // For ASSISTANT
  }
}

message ChatMessageIntent {
  IntentGeneric generic = 1;           // oneof intent type
}

message IntentGeneric {
  string text = 1;                     // The actual user/system text
}

enum ChatMessageSource {
  UNSPECIFIED = 0;
  USER = 1;
  SYSTEM = 2;
  ASSISTANT = 3;
  TOOL = 4;
}
```

### RawGetChatMessageResponse (streaming)

```protobuf
message RawGetChatMessageResponse {
  RawChatMessage delta_message = 1;    // Incremental response chunk
}

message RawChatMessage {
  string message_id = 1;
  ChatMessageSource source = 2;
  google.protobuf.Timestamp timestamp = 3;
  string conversation_id = 4;
  string text = 5;                     // The content delta we extract
  bool in_progress = 6;
  bool is_error = 7;
}
```

### GetChatMessageRequest (standard Cascade format)

```protobuf
message GetChatMessageRequest {
  Metadata metadata = 1;
  string cascade_id = 2;
  ModelOrAlias model_or_alias = 3;
  repeated StandardChatMessage messages = 4;
  repeated ChatToolDefinition tools = 5;
  ChatToolChoice tool_choice = 6;
  EnterpriseExternalModelConfig enterprise_config = 7;
  PromptCacheOptions cache_options = 8;
}

message StandardChatMessage {
  string role = 1;                     // "user", "assistant", "system", "tool"
  string content = 2;
  string tool_call_id = 3;
  repeated ChatToolCall tool_calls = 4;
}

message ChatToolCall {
  string id = 1;
  string name = 2;
  string arguments = 3;               // JSON string
}
```

### Streaming Response (standard format)

```protobuf
message CompletionChunk {
  oneof chunk {
    ContentChunk content = 1;
    ToolCallChunk tool_call = 2;
    DoneChunk done = 3;
    ErrorChunk error = 4;
  }
}

message ContentChunk {
  string text = 1;
}

message DoneChunk {
  UsageStats usage = 1;
}

message UsageStats {
  int32 prompt_tokens = 1;
  int32 completion_tokens = 2;
}
```

## gRPC Framing

Standard gRPC framing is used:

```
[1 byte: compression flag (0x00 = none)] [4 bytes: big-endian payload length] [N bytes: protobuf payload]
```

Multiple frames may be concatenated in a single HTTP/2 DATA chunk. The plugin iterates through frames by reading the 5-byte header, extracting the payload, and parsing it as protobuf.

## HTTP Headers

### Local Language Server
```
content-type: application/grpc
te: trailers
x-codeium-csrf-token: {csrf_token}
```

### Remote API Server
```
Content-Type: application/grpc-web+proto
X-Codeium-Csrf-Token: {csrf_token}
Authorization: Bearer {firebase_id_token}
User-Agent: windsurf/{version}
```

## Model Identifiers

### Protobuf Enum Values (extracted from extension.js)

#### Windsurf Proprietary
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| SWE-1.5 | 359 | `swe-1.5` |
| SWE-1.5 Thinking | 369 | `swe-1.5-thinking` |
| SWE-1.5 Slow | 377 | `swe-1.5-slow` |

#### Claude
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| Claude 3.5 Sonnet | 166 | `claude-3.5-sonnet` |
| Claude 3.7 Sonnet | 226 | `claude-3.7-sonnet` |
| Claude 3.7 Sonnet Thinking | 227 | `claude-3.7-sonnet-thinking` |
| Claude 4 Opus | 290 | `claude-4-opus` |
| Claude 4 Opus Thinking | 291 | `claude-4-opus-thinking` |
| Claude 4 Sonnet | 281 | `claude-4-sonnet` |
| Claude 4 Sonnet Thinking | 282 | `claude-4-sonnet-thinking` |
| Claude 4.1 Opus | 328 | `claude-4.1-opus` |
| Claude 4.1 Opus Thinking | 329 | `claude-4.1-opus-thinking` |
| Claude 4.5 Sonnet | 353 | `claude-4.5-sonnet` |
| Claude 4.5 Sonnet Thinking | 354 | `claude-4.5-sonnet-thinking` |
| Claude 4.5 Opus | 391 | `claude-4.5-opus` |
| Claude 4.5 Opus Thinking | 392 | `claude-4.5-opus-thinking` |
| Claude Code | 344 | `claude-code` |

#### GPT
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| GPT-4o | 109 | `gpt-4o` |
| GPT-4.1 | 259 | `gpt-4.1` |
| GPT-4.1 Mini | 260 | `gpt-4.1-mini` |
| GPT-4.1 Nano | 261 | `gpt-4.1-nano` |
| GPT-5 | 340 | `gpt-5` |
| GPT-5 Nano | 337 | `gpt-5-nano` |
| GPT-5 Codex | 346 | `gpt-5-codex` |
| GPT-5.1 Codex (medium) | 389 | `gpt-5.1-codex` |
| GPT-5.1 Codex Max (medium) | 396 | `gpt-5.1-codex-max` |
| GPT-5.2 (medium) | 401 | `gpt-5.2` |
| GPT-5.2 Low | 400 | `gpt-5.2:low` |
| GPT-5.2 High | 402 | `gpt-5.2:high` |
| GPT-5.2 XHigh | 403 | `gpt-5.2:xhigh` |

#### O-Series
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| O3 | 218 | `o3` |
| O3 Mini | 207 | `o3-mini` |
| O3 Pro | 294 | `o3-pro` |
| O4 Mini | 264 | `o4-mini` |

#### Gemini
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| Gemini 2.0 Flash | 184 | `gemini-2.0-flash` |
| Gemini 2.5 Pro | 246 | `gemini-2.5-pro` |
| Gemini 2.5 Flash | 312 | `gemini-2.5-flash` |
| Gemini 3.0 Pro (medium) | 412 | `gemini-3.0-pro` |
| Gemini 3.0 Flash (medium) | 415 | `gemini-3.0-flash` |

#### Other
| Model | Enum Value | Canonical Name |
|-------|------------|----------------|
| DeepSeek V3 | 205 | `deepseek-v3` |
| DeepSeek V3-2 | 409 | `deepseek-v3-2` |
| DeepSeek R1 | 206 | `deepseek-r1` |
| Qwen 3 Coder 480B | 325 | `qwen-3-coder-480b` |
| Grok 3 | 217 | `grok-3` |
| Grok Code Fast | 345 | `grok-code-fast` |
| Kimi K2 | 323 | `kimi-k2` |
| GLM 4.7 | 417 | `glm-4.7` |
| MiniMax M2.1 | 419 | `minimax-m2.1` |

Full enum list (90+ entries): see `src/plugin/types.ts`

### Windsurf Internal Model IDs (string-based)

| Model | Internal ID |
|-------|------------|
| SWE-1 | `swe-1-model-id` |
| SWE-1.5 | `cognition-swe-1.5` |
| SWE-1 Lite | `swe-1-lite-model-id` |
| Vista | `vista-model-id` |
| Shamu | `shamu-model-id` |

## Rate Limiting

- Rate limits vary by subscription tier
- 429 responses include `Retry-After` header
- `CheckUserMessageRateLimit` can be called proactively

## Local Storage

### Config Locations

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Windsurf/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Windsurf\User\globalStorage\state.vscdb` |

### Legacy Config

| Platform | Path |
|----------|------|
| All | `~/.codeium/config.json` |

### Key Files

| File | Purpose |
|------|---------|
| `state.vscdb` | SQLite DB containing `windsurfAuthStatus` (API key) |
| `installation_id` | Unique installation UUID |
| `user_settings.pb` | Protobuf settings |
| `mcp_config.json` | MCP configuration |

### Keychain (macOS)

- Service: `Windsurf Safe Storage`
- Account: `Windsurf Key`
- Note: Encrypted with Electron's safeStorage

## BYOK (Bring Your Own Key)

Windsurf supports BYOK for:
- Claude models (`*_BYOK` variants)
- OpenRouter models (`*_OPEN_ROUTER_BYOK` variants)
- Databricks models (`*_DATABRICKS` variants)

BYOK configuration is stored in user settings and sent via `EnterpriseExternalModelConfig`.
