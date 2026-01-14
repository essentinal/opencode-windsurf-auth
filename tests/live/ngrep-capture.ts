#!/usr/bin/env bun
/**
 * Capture real Windsurf gRPC traffic using ngrep
 * 
 * This passively captures traffic on the loopback interface to see
 * exactly what the Windsurf extension sends to the language server.
 * 
 * Usage:
 *   sudo bun run tests/live/ngrep-capture.ts
 * 
 * Then immediately send a message in Cascade (Windsurf chat).
 */

import { spawn, execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

const FIXTURES_DIR = path.join(import.meta.dir, "../fixtures");

function getPort(): number {
  const psOutput = execSync("ps aux | grep language_server_macos | grep -v grep", {
    encoding: "utf8",
  });
  const portMatch = psOutput.match(/--extension_server_port\s+(\d+)/);
  return parseInt(portMatch?.[1] || "0", 10) + 2;
}

async function main() {
  const port = getPort();
  if (!port) {
    console.error("Windsurf not running");
    process.exit(1);
  }

  // Check if running as root
  if (process.getuid?.() !== 0) {
    console.error("This script requires sudo to capture traffic.");
    console.error(`Run: sudo bun run tests/live/ngrep-capture.ts`);
    process.exit(1);
  }

  console.log("=== Windsurf Traffic Capture (ngrep) ===");
  console.log(`Capturing on port ${port}`);
  console.log("\n>>> NOW send a message in Cascade! <<<\n");
  console.log("Press Ctrl+C after you see the request to stop.\n");

  fs.mkdirSync(FIXTURES_DIR, { recursive: true });

  // Use ngrep to capture gRPC traffic
  // -x shows hex dump
  // -q quiet mode (less metadata)
  // -d lo0 loopback interface
  const ngrep = spawn("ngrep", [
    "-x",
    "-q", 
    "-d", "lo0",
    "-W", "single",  // Single line per packet
    `port ${port}`,
  ]);

  let allOutput = "";
  let packetCount = 0;

  ngrep.stdout.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    allOutput += text;
    process.stdout.write(text);
    
    // Count packets
    const newPackets = (text.match(/^T /gm) || []).length;
    packetCount += newPackets;
  });

  ngrep.stderr.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk.toString());
  });

  process.on("SIGINT", () => {
    console.log("\n\nStopping capture...");
    ngrep.kill();

    // Save raw output
    const outputPath = path.join(FIXTURES_DIR, `ngrep-${Date.now()}.txt`);
    fs.writeFileSync(outputPath, allOutput);
    console.log(`Saved ${packetCount} packets to ${outputPath}`);

    // Try to extract and analyze gRPC frames
    analyzeCapture(allOutput);

    process.exit(0);
  });
}

function analyzeCapture(output: string): void {
  console.log("\n=== Analyzing Capture ===\n");

  // Look for hex data in the output
  // ngrep with -x outputs hex like: "0a 19 0a 08 77 69 ..."
  const hexMatches = output.match(/[0-9a-f]{2}( [0-9a-f]{2})+/gi) || [];
  
  for (const hexStr of hexMatches) {
    const hex = hexStr.replace(/\s/g, "");
    if (hex.length < 20) continue; // Skip small fragments
    
    const buffer = Buffer.from(hex, "hex");
    
    // Look for gRPC frame marker (starts with 00 and has reasonable length)
    for (let i = 0; i < buffer.length - 5; i++) {
      if (buffer[i] === 0x00) {
        const len = buffer.readUInt32BE(i + 1);
        if (len > 10 && len < 5000 && i + 5 + len <= buffer.length) {
          const payload = buffer.subarray(i + 5, i + 5 + len);
          
          console.log(`Found potential gRPC frame at offset ${i}:`);
          console.log(`  Length: ${len}`);
          console.log(`  Hex: ${payload.toString("hex").slice(0, 100)}...`);
          
          // Try to parse protobuf
          const fields = parseProtobuf(payload);
          if (fields.length > 0) {
            console.log(`  Parsed fields:`);
            console.log(JSON.stringify(fields, null, 4));
            
            // Save as fixture
            const fixturePath = path.join(FIXTURES_DIR, `grpc-frame-${Date.now()}.json`);
            fs.writeFileSync(fixturePath, JSON.stringify({
              hex: payload.toString("hex"),
              fields,
            }, null, 2));
            console.log(`  Saved to ${fixturePath}\n`);
          }
        }
      }
    }
  }
}

interface ProtobufField {
  field: number;
  wire: number;
  value: unknown;
}

function parseProtobuf(buffer: Buffer): ProtobufField[] {
  const fields: ProtobufField[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    // Read tag
    let tag = 0n;
    let shift = 0n;
    let pos = offset;
    while (pos < buffer.length) {
      const byte = buffer[pos++];
      tag |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) break;
      shift += 7n;
    }

    const fieldNum = Number(tag >> 3n);
    const wireType = Number(tag & 0x7n);
    if (fieldNum === 0 || fieldNum > 536870911) break;

    let value: unknown;
    let end = pos;

    try {
      switch (wireType) {
        case 0: // Varint
          let v = 0n;
          let vs = 0n;
          while (end < buffer.length) {
            const byte = buffer[end++];
            v |= BigInt(byte & 0x7f) << vs;
            if ((byte & 0x80) === 0) break;
            vs += 7n;
          }
          value = Number(v);
          break;

        case 2: // Length-delimited
          let len = 0n;
          let ls = 0n;
          while (end < buffer.length) {
            const byte = buffer[end++];
            len |= BigInt(byte & 0x7f) << ls;
            if ((byte & 0x80) === 0) break;
            ls += 7n;
          }
          const numLen = Number(len);
          if (numLen < 0 || end + numLen > buffer.length) break;
          
          const data = buffer.subarray(end, end + numLen);
          end += numLen;

          // Try as string first
          const str = data.toString("utf8");
          if (/^[\x20-\x7e\n\r\t]+$/.test(str) && str.length > 0) {
            value = str;
          } else {
            // Try as embedded message
            const embedded = parseProtobuf(data);
            if (embedded.length > 0 && embedded[0].field > 0) {
              value = { embedded };
            } else {
              value = { hex: data.toString("hex") };
            }
          }
          break;

        case 1: // 64-bit
          value = { fixed64: buffer.subarray(end, end + 8).toString("hex") };
          end += 8;
          break;

        case 5: // 32-bit  
          value = { fixed32: buffer.subarray(end, end + 4).toString("hex") };
          end += 4;
          break;

        default:
          return fields; // Unknown wire type, stop parsing
      }

      fields.push({ field: fieldNum, wire: wireType, value });
      offset = end;
    } catch {
      break;
    }
  }

  return fields;
}

main().catch(console.error);
