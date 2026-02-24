/**
 * Windsurf Credential Discovery Module
 * 
 * Automatically discovers credentials from the running Windsurf language server:
 * - CSRF token from process arguments
 * - Port from process arguments (extension_server_port + 2)
 * - API key from VSCode state database (~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb)
 * - Version from process arguments
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface WindsurfCredentials {
  /** CSRF token for authenticating with local language server */
  csrfToken: string;
  /** Port where the language server is listening */
  port: number;
  /** Codeium API key */
  apiKey: string;
  /** Windsurf version string */
  version: string;
}

export enum WindsurfErrorCode {
  NOT_RUNNING = 'NOT_RUNNING',
  CSRF_MISSING = 'CSRF_MISSING',
  API_KEY_MISSING = 'API_KEY_MISSING',
  CONNECTION_FAILED = 'CONNECTION_FAILED',
  AUTH_FAILED = 'AUTH_FAILED',
  STREAM_ERROR = 'STREAM_ERROR',
}

export class WindsurfError extends Error {
  code: WindsurfErrorCode;
  details?: unknown;

  constructor(message: string, code: WindsurfErrorCode, details?: unknown) {
    super(message);
    this.name = 'WindsurfError';
    this.code = code;
    this.details = details;
  }
}

// ============================================================================
// Config Paths
// ============================================================================

// Paths for API key discovery
const VSCODE_STATE_PATHS = {
  darwin: path.join(os.homedir(), 'Library/Application Support/Windsurf/User/globalStorage/state.vscdb'),
  linux: path.join(os.homedir(), '.config/Windsurf/User/globalStorage/state.vscdb'),
  win32: path.join(os.homedir(), 'AppData/Roaming/Windsurf/User/globalStorage/state.vscdb'),
} as const;

// Legacy config path (fallback)
const LEGACY_CONFIG_PATH = path.join(os.homedir(), '.codeium', 'config.json');

// Platform-specific process names
const LANGUAGE_SERVER_PATTERNS = {
  darwin: 'language_server_macos',
  linux: 'language_server_linux_x64',
  win32: 'language_server_windows',
} as const;

// ============================================================================
// Process Discovery
// ============================================================================

/**
 * Get the language server process pattern for the current platform
 */
function getLanguageServerPattern(): string {
  const platform = process.platform as keyof typeof LANGUAGE_SERVER_PATTERNS;
  return LANGUAGE_SERVER_PATTERNS[platform] || 'language_server';
}

interface LanguageServerProcess {
  pid: string;
  csrfToken: string;
  extensionServerPort: number | null;
  line: string;
}

/**
 * Parse all language server processes and return them as structured entries.
 * Each entry contains the PID, CSRF token, and extension_server_port from the same line,
 * ensuring they always belong to the same process.
 */
function getLanguageServerProcesses(): LanguageServerProcess[] {
  const pattern = getLanguageServerPattern();

  try {
    let output: string;
    if (process.platform === 'win32') {
      output = execSync(
        `wmic process where "name like '%${pattern}%'" get CommandLine,ProcessId /format:list`,
        { encoding: 'utf8', timeout: 5000 }
      );
    } else {
      output = execSync(
        `ps aux | grep ${pattern}`,
        { encoding: 'utf8', timeout: 5000 }
      );
    }

    const results: LanguageServerProcess[] = [];
    for (const line of output.split('\n')) {
      if (!line.includes(pattern) || line.includes('grep')) continue;

      const pidMatch = line.match(/^\s*\S+\s+(\d+)/);
      const csrfMatch = line.match(/--csrf_token\s+([a-f0-9-]+)/);
      const portMatch = line.match(/--extension_server_port\s+(\d+)/);

      if (pidMatch && csrfMatch) {
        results.push({
          pid: pidMatch[1],
          csrfToken: csrfMatch[1],
          extensionServerPort: portMatch ? parseInt(portMatch[1], 10) : null,
          line,
        });
      }
    }

    return results;
  } catch {
    return [];
  }
}

/**
 * Find the gRPC listening port for a specific PID using /proc (Linux) or lsof (macOS).
 */
function getPortForPid(pid: string, extPort: number | null): number | null {
  if (process.platform === 'linux') {
    try {
      // Get all listening ports for this PID via its fd symlinks in /proc
      const fdDir = `/proc/${pid}/fd`;
      const socketInodes = new Set<string>();
      try {
        const fds = execSync(`ls -la ${fdDir} 2>/dev/null | grep socket`, {
          encoding: 'utf8', timeout: 5000,
        });
        for (const fdLine of fds.split('\n')) {
          const m = fdLine.match(/socket:\[(\d+)\]/);
          if (m) socketInodes.add(m[1]);
        }
      } catch {
        // ignore
      }

      if (socketInodes.size > 0) {
        // Parse /proc/net/tcp and tcp6 to find ports for these inodes
        const netFiles = ['/proc/net/tcp', '/proc/net/tcp6'];
        const listeningPorts: number[] = [];
        for (const netFile of netFiles) {
          try {
            const content = execSync(`cat ${netFile} 2>/dev/null`, { encoding: 'utf8', timeout: 5000 });
            for (const line of content.split('\n').slice(1)) {
              const cols = line.trim().split(/\s+/);
              if (cols[3] === '0A' && socketInodes.has(cols[9])) {
                const portHex = cols[1].split(':')[1];
                if (portHex) listeningPorts.push(parseInt(portHex, 16));
              }
            }
          } catch {
            // ignore
          }
        }

        if (listeningPorts.length > 0) {
          if (extPort) {
            const after = listeningPorts.filter(p => p > extPort).sort((a, b) => a - b);
            if (after.length > 0) return after[0];
          }
          return listeningPorts.sort((a, b) => a - b)[0];
        }
      }

      // Fallback: ss or lsof
      try {
        const ss = execSync(`ss -tlnp 2>/dev/null | grep pid=${pid}`, { encoding: 'utf8', timeout: 5000 });
        const ports: number[] = [];
        for (const line of ss.split('\n')) {
          if (!line.includes(`pid=${pid}`)) continue;
          const m = line.match(/:(\d+)\s/);
          if (m) ports.push(parseInt(m[1], 10));
        }
        if (ports.length > 0) {
          if (extPort) {
            const after = ports.filter(p => p > extPort).sort((a, b) => a - b);
            if (after.length > 0) return after[0];
          }
          return ports.sort((a, b) => a - b)[0];
        }
      } catch {
        // ignore
      }
    } catch {
      // ignore
    }
  } else if (process.platform === 'darwin') {
    try {
      const lsof = execSync(
        `lsof -a -p ${pid} -i -P -n 2>/dev/null | grep LISTEN`,
        { encoding: 'utf8', timeout: 15000 }
      );
      const ports: number[] = [];
      for (const m of lsof.matchAll(/:(\d+)\s+\(LISTEN\)/g)) {
        ports.push(parseInt(m[1], 10));
      }
      if (ports.length > 0) {
        if (extPort) {
          const after = ports.filter(p => p > extPort).sort((a, b) => a - b);
          if (after.length > 0) return after[0];
        }
        return ports[0];
      }
    } catch {
      // ignore
    }
  }

  // Last resort: offset fallback
  if (extPort) return extPort + 3;
  return null;
}

/**
 * Extract CSRF token from running Windsurf language server process
 */
export function getCSRFToken(): string {
  const processes = getLanguageServerProcesses();

  if (processes.length === 0) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  return processes[0].csrfToken;
}

/**
 * Get the language server gRPC port dynamically.
 * Always resolved from the same process as the CSRF token.
 */
export function getPort(): number {
  const processes = getLanguageServerProcesses();

  if (processes.length === 0) {
    throw new WindsurfError(
      'Windsurf language server not found. Is Windsurf running?',
      WindsurfErrorCode.NOT_RUNNING
    );
  }

  const proc = processes[0];
  const port = getPortForPid(proc.pid, proc.extensionServerPort);

  if (port !== null) return port;

  throw new WindsurfError(
    'Windsurf language server port not found. Is Windsurf running?',
    WindsurfErrorCode.NOT_RUNNING
  );
}

/**
 * Read API key from VSCode state database (windsurfAuthStatus)
 * 
 * The API key is stored in the SQLite database at:
 * ~/Library/Application Support/Windsurf/User/globalStorage/state.vscdb
 * 
 * It's stored in the 'windsurfAuthStatus' key as JSON containing apiKey.
 */
export function getApiKey(): string {
  const platform = process.platform as keyof typeof VSCODE_STATE_PATHS;
  const statePath = VSCODE_STATE_PATHS[platform];
  
  if (!statePath) {
    throw new WindsurfError(
      `Unsupported platform: ${process.platform}`,
      WindsurfErrorCode.API_KEY_MISSING
    );
  }
  
  // Try to get API key from VSCode state database
  if (fs.existsSync(statePath)) {
    try {
      const result = execSync(
        `sqlite3 "${statePath}" "SELECT value FROM ItemTable WHERE key = 'windsurfAuthStatus';"`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed.apiKey) {
          return parsed.apiKey;
        }
      }
    } catch (error) {
      // Fall through to legacy config
    }
  }
  
  // Try legacy config file
  if (fs.existsSync(LEGACY_CONFIG_PATH)) {
    try {
      const config = fs.readFileSync(LEGACY_CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(config);
      if (parsed.apiKey) {
        return parsed.apiKey;
      }
    } catch {
      // Fall through
    }
  }
  
  throw new WindsurfError(
    'API key not found. Please login to Windsurf first.',
    WindsurfErrorCode.API_KEY_MISSING
  );
}

/**
 * Get Windsurf version from process arguments
 */
export function getWindsurfVersion(): string {
  const processes = getLanguageServerProcesses();

  if (processes.length > 0) {
    const match = processes[0].line.match(/--windsurf_version\s+([^\s]+)/);
    if (match) {
      return match[1].split('+')[0];
    }
  }

  return '1.13.104';
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all credentials needed to communicate with Windsurf
 */
export function getCredentials(): WindsurfCredentials {
  return {
    csrfToken: getCSRFToken(),
    port: getPort(),
    apiKey: getApiKey(),
    version: getWindsurfVersion(),
  };
}

/**
 * Check if Windsurf is running and accessible
 */
export function isWindsurfRunning(): boolean {
  try {
    getCSRFToken();
    getPort();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Windsurf is installed (app exists)
 */
export function isWindsurfInstalled(): boolean {
  if (process.platform === 'darwin') {
    return fs.existsSync('/Applications/Windsurf.app');
  } else if (process.platform === 'linux') {
    return (
      fs.existsSync('/usr/share/windsurf') ||
      fs.existsSync(path.join(os.homedir(), '.local/share/windsurf'))
    );
  } else if (process.platform === 'win32') {
    return (
      fs.existsSync('C:\\Program Files\\Windsurf') ||
      fs.existsSync(path.join(os.homedir(), 'AppData\\Local\\Programs\\Windsurf'))
    );
  }
  return false;
}

/**
 * Validate credentials structure
 */
export function validateCredentials(credentials: Partial<WindsurfCredentials>): credentials is WindsurfCredentials {
  return (
    typeof credentials.csrfToken === 'string' &&
    credentials.csrfToken.length > 0 &&
    typeof credentials.port === 'number' &&
    credentials.port > 0 &&
    typeof credentials.apiKey === 'string' &&
    credentials.apiKey.length > 0 &&
    typeof credentials.version === 'string'
  );
}
