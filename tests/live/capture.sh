#!/bin/bash
#
# Capture Windsurf gRPC traffic
#
# Usage:
#   sudo ./tests/live/capture.sh
#
# Then IMMEDIATELY send a message in Cascade (Windsurf chat).
# Press Ctrl+C after you see traffic to stop and analyze.
#

set -e

# Get the gRPC port from running Windsurf process
PORT=$(ps aux | grep language_server_macos | grep -v grep | grep -oE '\-\-extension_server_port\s+[0-9]+' | awk '{print $2}')
if [ -z "$PORT" ]; then
    echo "Error: Windsurf is not running"
    exit 1
fi

GRPC_PORT=$((PORT + 2))
FIXTURES_DIR="$(dirname "$0")/../fixtures"
OUTPUT_FILE="$FIXTURES_DIR/capture-$(date +%s).pcap"

mkdir -p "$FIXTURES_DIR"

echo "=== Windsurf Traffic Capture ==="
echo "gRPC Port: $GRPC_PORT"
echo "Output: $OUTPUT_FILE"
echo ""
echo ">>> NOW send a message in Cascade! <<<"
echo ""
echo "Press Ctrl+C after you see traffic to stop."
echo ""

# Capture with tcpdump to pcap file
tcpdump -i lo0 -w "$OUTPUT_FILE" -s 0 "port $GRPC_PORT" &
TCPDUMP_PID=$!

# Also show live traffic
tcpdump -i lo0 -X -s 0 "port $GRPC_PORT" 2>/dev/null &
TCPDUMP_LIVE_PID=$!

cleanup() {
    echo ""
    echo "Stopping capture..."
    kill $TCPDUMP_PID 2>/dev/null || true
    kill $TCPDUMP_LIVE_PID 2>/dev/null || true
    wait $TCPDUMP_PID 2>/dev/null || true
    
    echo ""
    echo "Saved to: $OUTPUT_FILE"
    echo ""
    echo "To analyze, run:"
    echo "  bun run tests/live/analyze.ts $OUTPUT_FILE"
}

trap cleanup INT TERM

wait $TCPDUMP_LIVE_PID
