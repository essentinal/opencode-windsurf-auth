#!/usr/bin/env bun
/**
 * Analyze captured pcap file from Windsurf traffic
 * 
 * Usage:
 *   bun run tests/live/analyze.ts <capture.pcap>
 * 
 * Or analyze raw hex:
 *   bun run tests/live/analyze.ts --hex <hexstring>
 */

import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";

const FIXTURES_DIR = path.join(import.meta.dir, "../fixtures");

interface ProtobufField {
  field: number;
  wire: number;
  value: unknown;
}

function parseProtobuf(buffer: Buffer, depth = 0): ProtobufField[] {
  if (depth > 10) return []; // Prevent infinite recursion
  
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
      if (shift > 63n) break; // Invalid varint
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
            if (vs > 63n) break;
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
            if (ls > 63n) break;
          }
          const numLen = Number(len);
          if (numLen < 0 || numLen > 100000 || end + numLen > buffer.length) break;
          
          const data = buffer.subarray(end, end + numLen);
          end += numLen;

          // Try as UTF-8 string first
          const str = data.toString("utf8");
          if (/^[\x20-\x7e\n\r\t]+$/.test(str) && str.length > 0) {
            value = str;
          } else {
            // Try as embedded message
            const embedded = parseProtobuf(data, depth + 1);
            if (embedded.length > 0 && embedded[0].field > 0 && embedded[0].field < 100) {
              value = { _embedded: embedded };
            } else {
              value = { _hex: data.toString("hex"), _len: numLen };
            }
          }
          break;

        case 1: // 64-bit
          if (end + 8 > buffer.length) break;
          value = { _fixed64: buffer.subarray(end, end + 8).toString("hex") };
          end += 8;
          break;

        case 5: // 32-bit  
          if (end + 4 > buffer.length) break;
          value = { _fixed32: buffer.subarray(end, end + 4).toString("hex") };
          end += 4;
          break;

        default:
          return fields;
      }

      fields.push({ field: fieldNum, wire: wireType, value });
      offset = end;
    } catch {
      break;
    }
  }

  return fields;
}

function findGrpcFrames(buffer: Buffer): Array<{ offset: number; length: number; payload: Buffer }> {
  const frames: Array<{ offset: number; length: number; payload: Buffer }> = [];
  
  for (let i = 0; i < buffer.length - 5; i++) {
    // gRPC frame: 1 byte compressed (0x00) + 4 bytes big-endian length
    if (buffer[i] === 0x00) {
      const len = buffer.readUInt32BE(i + 1);
      if (len > 5 && len < 50000 && i + 5 + len <= buffer.length) {
        const payload = buffer.subarray(i + 5, i + 5 + len);
        
        // Validate it looks like protobuf (first byte should be valid tag)
        const firstTag = payload[0];
        const fieldNum = firstTag >> 3;
        const wireType = firstTag & 0x7;
        if (fieldNum >= 1 && fieldNum <= 30 && wireType <= 5) {
          frames.push({ offset: i, length: len, payload });
          i += 4 + len; // Skip past this frame
        }
      }
    }
  }
  
  return frames;
}

function analyzePcap(pcapPath: string): void {
  console.log(`\nAnalyzing: ${pcapPath}\n`);
  
  // Use tshark to extract raw payload data
  let rawHex: string;
  try {
    // Extract HTTP/2 data frames
    rawHex = execSync(
      `tshark -r "${pcapPath}" -T fields -e data 2>/dev/null | tr -d '\\n'`,
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 }
    ).trim();
  } catch {
    // Fallback: read raw pcap and extract
    console.log("tshark not available, reading raw pcap...");
    const pcapData = fs.readFileSync(pcapPath);
    rawHex = pcapData.toString("hex");
  }
  
  if (!rawHex) {
    console.log("No data extracted from pcap");
    return;
  }
  
  console.log(`Extracted ${rawHex.length / 2} bytes\n`);
  
  const buffer = Buffer.from(rawHex, "hex");
  const frames = findGrpcFrames(buffer);
  
  console.log(`Found ${frames.length} potential gRPC frames\n`);
  
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i];
    console.log(`${"=".repeat(60)}`);
    console.log(`Frame ${i + 1}: offset=${frame.offset}, length=${frame.length}`);
    console.log(`${"=".repeat(60)}`);
    console.log(`Hex: ${frame.payload.toString("hex").slice(0, 200)}${frame.length > 100 ? "..." : ""}`);
    console.log("");
    
    const parsed = parseProtobuf(frame.payload);
    if (parsed.length > 0) {
      console.log("Parsed protobuf:");
      console.log(JSON.stringify(parsed, null, 2));
      
      // Save as fixture
      const fixturePath = path.join(FIXTURES_DIR, `frame-${i + 1}-${Date.now()}.json`);
      fs.writeFileSync(fixturePath, JSON.stringify({
        offset: frame.offset,
        length: frame.length,
        hex: frame.payload.toString("hex"),
        parsed,
      }, null, 2));
      console.log(`\nSaved to: ${fixturePath}`);
    }
    console.log("");
  }
}

function analyzeHex(hexString: string): void {
  console.log(`\nAnalyzing hex string (${hexString.length / 2} bytes)\n`);
  
  const buffer = Buffer.from(hexString.replace(/\s/g, ""), "hex");
  
  // First try as raw protobuf
  console.log("=== Trying as raw protobuf ===");
  let parsed = parseProtobuf(buffer);
  if (parsed.length > 0) {
    console.log(JSON.stringify(parsed, null, 2));
  }
  
  // Then try finding gRPC frames
  console.log("\n=== Looking for gRPC frames ===");
  const frames = findGrpcFrames(buffer);
  for (const frame of frames) {
    console.log(`\nFrame at offset ${frame.offset}, length ${frame.length}:`);
    parsed = parseProtobuf(frame.payload);
    console.log(JSON.stringify(parsed, null, 2));
  }
}

// Main
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage:");
  console.log("  bun run tests/live/analyze.ts <capture.pcap>");
  console.log("  bun run tests/live/analyze.ts --hex <hexstring>");
  process.exit(1);
}

if (args[0] === "--hex" && args[1]) {
  analyzeHex(args[1]);
} else if (fs.existsSync(args[0])) {
  analyzePcap(args[0]);
} else {
  console.error(`File not found: ${args[0]}`);
  process.exit(1);
}
