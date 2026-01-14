# Tests

## Directory Structure

```
tests/
├── unit/           # Unit tests (run with: bun test tests/unit)
├── live/           # Live integration tests against running Windsurf
│   ├── capture.sh  # Capture traffic (requires sudo)
│   ├── analyze.ts  # Analyze captured traffic
│   └── request.ts  # Send test requests to Windsurf
└── fixtures/       # Captured traffic samples (gitignored)
```

## Capturing Real Traffic

To understand the exact protobuf format Windsurf uses:

1. **Start Windsurf** and ensure it's running

2. **Run the capture script** (requires sudo for tcpdump):
   ```bash
   sudo ./tests/live/capture.sh
   ```

3. **Send a message in Cascade** (Windsurf's chat)

4. **Press Ctrl+C** to stop capturing

5. **Analyze the capture**:
   ```bash
   bun run test:analyze tests/fixtures/capture-*.pcap
   ```

## Test Commands

```bash
# Run unit tests
bun test

# Send test requests to running Windsurf
bun run test:request

# Analyze a pcap file
bun run test:analyze <file.pcap>

# Analyze raw hex
bun run test:analyze --hex <hexstring>
```
