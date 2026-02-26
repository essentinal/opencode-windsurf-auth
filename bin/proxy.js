#!/usr/bin/env bun
/**
 * Windsurf proxy daemon entry point.
 * Run this once before using OpenCode with Windsurf models.
 *
 * Usage:
 *   bun run proxy          (via npm script)
 *   bun bin/proxy.js       (direct)
 */

import '../dist/src/server.js';
