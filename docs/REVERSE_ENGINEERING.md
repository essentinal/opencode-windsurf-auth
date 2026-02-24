# Reverse Engineering Windsurf: Discovery Without Prior Knowledge

This document explains how Windsurf's local gRPC architecture was reverse-engineered, and how to reproduce the process for future updates.

## Why mitmproxy Failed

mitmproxy only captures HTTP/HTTPS traffic going through the network stack. Windsurf's language server communicates via **localhost gRPC** — traffic that never leaves the machine and bypasses any system proxy.

Key insight: **If mitmproxy shows nothing interesting, the app is likely talking to itself.**

## Step 1: Process Inspection

Start by examining what processes Windsurf spawns:

```bash
ps aux | grep -i windsurf
ps aux | grep -i language_server
```

Example output:
```
vedant  12345  0.5  1.2 language_server_macos --csrf_token abc123-def456 --extension_server_port 42100 --windsurf_version 1.13.104 --random_port
```

The process arguments are a goldmine:
- `--csrf_token` → Authentication token for local gRPC
- `--extension_server_port` → Base port reference
- `--windsurf_version` → Version string
- `--random_port` → Indicates gRPC port is randomized (not a fixed offset)

## Step 2: Network Port Discovery

The gRPC port is **not** at a fixed offset from `extension_server_port`. Use `lsof` to find the actual listening ports:

```bash
# Get PID
PID=$(pgrep -f language_server_macos)

# Find all listening ports for this process
lsof -p $PID -i -P -n 2>/dev/null | grep LISTEN
```

Example output:
```
language_server 12345 vedant 23u IPv4 TCP 127.0.0.1:42100 (LISTEN)
language_server 12345 vedant 24u IPv4 TCP 127.0.0.1:42101 (LISTEN)
language_server 12345 vedant 25u IPv4 TCP 127.0.0.1:42103 (LISTEN)
```

The gRPC port is the **first port greater than `extension_server_port`** (sorted ascending). Common offsets are +2, +3, or +4, but they vary due to `--random_port`.

```bash
# Automated port discovery
EXT_PORT=$(ps aux | grep language_server_macos | grep -oE '\-\-extension_server_port\s+[0-9]+' | awk '{print $2}')
GRPC_PORT=$(lsof -p $PID -i -P -n 2>/dev/null | grep LISTEN | grep -oP ':\K\d+' | sort -n | awk -v ext="$EXT_PORT" '$1 > ext {print; exit}')
echo "gRPC port: $GRPC_PORT"
```

**Fallback**: If `lsof` is unavailable, try `extension_server_port + 3` as a best guess.

## Step 3: API Key Discovery

### Primary: VSCode State Database

Windsurf stores authentication state in a SQLite database:

```bash
# macOS
sqlite3 ~/Library/Application\ Support/Windsurf/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"
```

Returns JSON:
```json
{"apiKey": "abc123-your-key-here", "email": "user@example.com", ...}
```

Platform paths:
| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb` |
| Linux | `~/.config/Windsurf/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Windsurf\User\globalStorage\state.vscdb` |

### Legacy: Config File

Older Windsurf versions stored the key in a JSON file:

```bash
cat ~/.codeium/config.json
# {"apiKey": "abc123-your-key-here"}
```

### Debug Script

The repo includes `src/debug-auth.ts` which inspects both sources:

```bash
bun run src/debug-auth.ts
```

## Step 4: Extension Source Analysis

Electron apps bundle their extension code. Find and examine it:

```bash
# Locate the extension code
find /Applications/Windsurf.app -name "extension.js" 2>/dev/null

# The main extension file:
# /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
```

This file is minified but searchable:

```bash
# Search for gRPC service names
grep -oE 'exa\.[a-z_]+_pb\.[A-Za-z]+Service' extension.js | sort -u
# Output:
# exa.language_server_pb.LanguageServerService
# exa.api_server_pb.ApiServerService
# exa.seat_management_pb.SeatManagementService

# Search for RPC method names
grep -oE 'Raw[A-Za-z]+Message|Get[A-Za-z]+|Send[A-Za-z]+' extension.js | sort -u

# Model enum definitions
grep -oE '[A-Z][A-Z0-9_]{3,}\s*=\s*[0-9]+' extension.js | head -50
```

## Step 5: Dynamic Protobuf Field Discovery

Windsurf may change protobuf field numbers between versions. The plugin's `src/plugin/discovery.ts` handles this automatically by parsing `extension.js` at runtime.

### How It Works

The extension.js contains `newFieldList()` calls that define protobuf message structures:

```javascript
// Minified example from extension.js
newFieldList(()=>[{no:1,name:"api_key",kind:"scalar",T:9},{no:2,name:"ide_name",kind:"scalar",T:9},...])
```

The discovery module:
1. Reads the installed extension.js
2. Finds all `newFieldList(()=>[...])` patterns
3. Identifies the `Metadata` message (contains both `"api_key"` and `"ide_name"`, excludes telemetry messages with `"event_name"`)
4. Extracts `{no:X,name:"field_name"}` pairs via regex
5. Caches the result for the session

### Verification

```bash
# Check current field numbers manually
grep -oP 'no:(\d+),name:"(api_key|ide_name|ide_version|extension_version|session_id|locale)"' \
  /Applications/Windsurf.app/Contents/Resources/app/extensions/windsurf/dist/extension.js
```

### Default Fallback

If discovery fails (file not found, parse error), defaults are used:
```
api_key=1, ide_name=2, ide_version=3, extension_version=4, session_id=5, locale=6
```

## Step 6: Traffic Capture on Localhost

To see the actual gRPC traffic:

```bash
# Use tcpdump on loopback interface
sudo tcpdump -i lo0 -A port $GRPC_PORT

# Or use ngrep for pattern matching
sudo ngrep -d lo0 -W byline port $GRPC_PORT
```

The repo includes capture/analysis tools:
```bash
# Capture traffic (requires sudo)
sudo ./tests/live/capture.sh

# Analyze captured pcap
bun run test:analyze tests/fixtures/capture-*.pcap
```

## Step 7: Protocol Reconstruction

From the captured traffic and source code analysis:

1. **Service path**: `POST /exa.language_server_pb.LanguageServerService/RawGetChatMessage`
2. **Headers**:
   - `content-type: application/grpc`
   - `te: trailers`
   - `x-codeium-csrf-token: {token from process args}`
3. **Body**: gRPC-framed protobuf message (see [WINDSURF_API_SPEC.md](WINDSURF_API_SPEC.md))

### gRPC Framing

```
[0x00] [4 bytes: big-endian length] [protobuf payload]
```

### Key Protocol Detail: Field 5 Overloading

Field 5 in `ChatMessage` is overloaded based on the `source` enum:
- **USER/SYSTEM/TOOL** (source 1/2/4): Field 5 is a nested `ChatMessageIntent` message containing `IntentGeneric.text`
- **ASSISTANT** (source 3): Field 5 is a plain string

Both use wire type 2 (length-delimited) but the internal structure differs. The plugin handles this in `encodeChatMessage()`.

## Step 8: Model Enum Extraction

The extension.js contains all model definitions:

```bash
# Extract model enums
grep -oE '[A-Z][A-Z0-9_]+\s*=\s*[0-9]+' extension.js | grep -E 'CLAUDE|GPT|GEMINI|DEEPSEEK|SWE|GROK|QWEN|LLAMA|KIMI|GLM|MINIMAX'
```

Look for patterns like:
```javascript
e.CLAUDE_4_5_SONNET = 353
e.GPT_5 = 340
e.SWE_1_5 = 359
e.GEMINI_3_0_PRO_MEDIUM = 412
```

These values go into `src/plugin/types.ts` as the `ModelEnum` constant.

## Step 9: Verify with curl

Test your findings:

```bash
# Get credentials
CSRF=$(ps aux | grep language_server_macos | grep -oE '\-\-csrf_token\s+[a-f0-9-]+' | awk '{print $2}')
PID=$(pgrep -f language_server_macos)
EXT_PORT=$(ps aux | grep language_server_macos | grep -oE '\-\-extension_server_port\s+[0-9]+' | awk '{print $2}')
GRPC_PORT=$(lsof -p $PID -i -P -n 2>/dev/null | grep LISTEN | grep -oP ':\K\d+' | sort -n | awk -v ext="$EXT_PORT" '$1 > ext {print; exit}')

# Test the endpoint (will fail without proper protobuf, but confirms it's listening)
curl -v -X POST "http://localhost:$GRPC_PORT/exa.language_server_pb.LanguageServerService/RawGetChatMessage" \
  -H "content-type: application/grpc" \
  -H "te: trailers" \
  -H "x-codeium-csrf-token: $CSRF"
```

## Key Indicators of Local gRPC Architecture

1. **No network traffic in mitmproxy** → App is using localhost
2. **Process args contain tokens/ports** → Direct process communication
3. **Electron app with bundled extensions** → Look for extension.js
4. **gRPC service names in code** → `*_pb.*Service` patterns
5. **Protobuf enum definitions** → `UPPER_CASE = number` patterns

## Tools Summary

| Tool | Purpose |
|------|---------|
| `ps aux` | Process inspection, argument discovery |
| `lsof -p PID -i -P -n` | Dynamic port discovery |
| `sqlite3` | API key extraction from state.vscdb |
| `grep` | Source code analysis |
| `tcpdump` / `ngrep` | Localhost traffic capture |
| `curl` | Endpoint verification |
| `security` | Keychain credential discovery (macOS) |

## Alternative: Frida/LLDB

For deeper inspection, you can attach debuggers:

```bash
frida -n language_server_macos -l script.js
lldb -n language_server_macos
```

This allows intercepting function calls and inspecting memory, but is usually overkill for API discovery.

## Updating for New Windsurf Versions

When Windsurf updates:

1. **Model enums** may change → Re-extract from extension.js (Step 8)
2. **Metadata field numbers** may change → `discovery.ts` handles this automatically
3. **ChatMessage structure** may change → Capture traffic (Step 6) and compare
4. **Port offset** may change → `lsof`-based discovery handles this automatically
5. **API key location** may change → Check state.vscdb first, then config.json fallback

The plugin is designed to survive most version changes via `discovery.ts` and `lsof`-based port discovery. Only ChatMessage/Response structure changes require code updates.
