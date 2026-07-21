/**
 * Splice Configuration
 *
 * One place for every launch knob. Settings come from three layers, strongest
 * first:
 *
 *   1. environment variables       (per-launch overrides, always win)
 *   2. splice.config.json          (checked-in, shareable project config)
 *   3. built-in defaults
 *
 * The config file is discovered via SPLICE_CONFIG, then ./splice.config.json,
 * then ~/.splice/config.json. File values are projected onto the same
 * environment variables the rest of the codebase already reads — existing
 * modules keep their env contract untouched, and a real env var always wins.
 *
 * Importing this module applies the file config to process.env as a side
 * effect; src/index.ts and src/bridge_server.ts import it first for exactly
 * that reason. Secrets (SPLICE_ENCRYPTION_KEY) are deliberately env-only and
 * never read from the config file.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SpliceConfigValues {
  /** Open the Command Center dashboard automatically on startup. */
  autoOpenDashboard: boolean;
  /** Start the OpenClaw WebSocket gateway on boot. */
  enableOpenClaw: boolean;
  /** Port for the OpenClaw gateway. */
  openclawGatewayPort: number;
  /** Port for the Python bridge server. */
  bridgePort: number;
  /** Launch Chromium with a visible window instead of headless. */
  watchMode: boolean;
  /** Discord webhook URL for event notifications. */
  discordWebhookUrl?: string;
  /** Opt-in endpoint for anonymized recovery-pattern telemetry. */
  telemetryUrl?: string;
  /** Attach vision previews (pixel crops of chosen targets) to key tools by default. */
  visionByDefault: boolean;
  /** Max automatic vision captures per session; explicit includeVision: true is never blocked. */
  visionBudget: number;
  /**
   * Standing permission to optimize intents inside compile_verified_action
   * (strip filler, ground targets against visible labels, separate values).
   * Off by default: rewrites then happen only when a call passes
   * optimizeIntent: true. Applied rewrites always travel back in
   * plan.intentOptimization with the original preserved.
   */
  promptOptimization: boolean;
  /** Enable Web Bot Auth request signing (RFC 9421) for the opted-in origins. */
  webBotAuth: boolean;
  /** Signature-Agent directory URL where the public JWK Set is hosted. */
  webBotAuthDirectory?: string;
  /** Comma-separated origin allowlist that Web Bot Auth signatures cover. */
  webBotAuthOrigins?: string;
}

export type ConfigSource = 'default' | 'file' | 'env';

export interface ResolvedConfig {
  values: SpliceConfigValues;
  sources: Record<keyof SpliceConfigValues, ConfigSource>;
  warnings: string[];
  configPath: string | null;
}

interface KeySpec {
  env: string;
  kind: 'boolean' | 'number' | 'string';
  default: boolean | number | string | undefined;
}

export const CONFIG_KEYS: Record<keyof SpliceConfigValues, KeySpec> = {
  autoOpenDashboard: { env: 'SPLICE_AUTO_OPEN_DASHBOARD', kind: 'boolean', default: false },
  enableOpenClaw: { env: 'SPLICE_ENABLE_OPENCLAW', kind: 'boolean', default: false },
  openclawGatewayPort: { env: 'OPENCLAW_GATEWAY_PORT', kind: 'number', default: 18789 },
  bridgePort: { env: 'SPLICE_BRIDGE_PORT', kind: 'number', default: 4000 },
  watchMode: { env: 'SPLICE_WATCH_MODE', kind: 'boolean', default: false },
  discordWebhookUrl: { env: 'DISCORD_WEBHOOK_URL', kind: 'string', default: undefined },
  telemetryUrl: { env: 'SPLICE_TELEMETRY_URL', kind: 'string', default: undefined },
  visionByDefault: { env: 'SPLICE_VISION_BY_DEFAULT', kind: 'boolean', default: true },
  visionBudget: { env: 'SPLICE_VISION_BUDGET', kind: 'number', default: 20 },
  promptOptimization: { env: 'SPLICE_PROMPT_OPTIMIZATION', kind: 'boolean', default: false },
  webBotAuth: { env: 'SPLICE_WEB_BOT_AUTH', kind: 'boolean', default: false },
  webBotAuthDirectory: { env: 'SPLICE_WEB_BOT_AUTH_DIRECTORY', kind: 'string', default: undefined },
  webBotAuthOrigins: { env: 'SPLICE_WEB_BOT_AUTH_ORIGINS', kind: 'string', default: undefined },
};

/** Locate the active config file, if any. */
export function findConfigFile(
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env
): string | null {
  if (env.SPLICE_CONFIG) return env.SPLICE_CONFIG;
  const local = path.join(cwd, 'splice.config.json');
  if (fs.existsSync(local)) return local;
  const home = path.join(os.homedir(), '.splice', 'config.json');
  if (fs.existsSync(home)) return home;
  return null;
}

function parseBooleanEnv(raw: string): boolean | undefined {
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  return undefined;
}

/**
 * Merge defaults ← config file ← environment into the effective config.
 * Pure given explicit options, so it is directly testable; without options it
 * reads the real process state.
 */
export function resolveConfig(options?: {
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  cwd?: string;
}): ResolvedConfig {
  const env = options?.env ?? process.env;
  const configPath =
    options?.configPath !== undefined ? options.configPath : findConfigFile(options?.cwd, env);

  const warnings: string[] = [];
  let fileValues: Record<string, unknown> = {};
  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileValues = parsed as Record<string, unknown>;
      } else {
        warnings.push(`Config file ${configPath} must contain a JSON object; ignoring it.`);
      }
    } catch (e: any) {
      warnings.push(`Could not read config file ${configPath}: ${e?.message ?? e}. Using defaults + env.`);
    }
  }

  for (const key of Object.keys(fileValues)) {
    if (key in CONFIG_KEYS) continue;
    if (key === 'encryptionKey') {
      warnings.push(
        'encryptionKey is not read from the config file — secrets stay in the SPLICE_ENCRYPTION_KEY environment variable.'
      );
    } else if (key !== '$schema') {
      warnings.push(`Unknown config key "${key}" ignored. Known keys: ${Object.keys(CONFIG_KEYS).join(', ')}.`);
    }
  }

  const values = {} as SpliceConfigValues;
  const sources = {} as Record<keyof SpliceConfigValues, ConfigSource>;

  for (const [key, spec] of Object.entries(CONFIG_KEYS) as Array<[keyof SpliceConfigValues, KeySpec]>) {
    let value: unknown = spec.default;
    let source: ConfigSource = 'default';

    if (key in fileValues) {
      const raw = fileValues[key];
      const kindOk =
        spec.kind === 'boolean' ? typeof raw === 'boolean'
        : spec.kind === 'number' ? typeof raw === 'number' && Number.isFinite(raw)
        : typeof raw === 'string';
      if (kindOk) {
        value = raw;
        source = 'file';
      } else {
        warnings.push(`Config key "${key}" must be a ${spec.kind}; got ${JSON.stringify(raw)}. Using ${source === 'default' ? 'default' : 'previous'} value.`);
      }
    }

    const rawEnv = env[spec.env];
    if (rawEnv !== undefined && rawEnv !== '') {
      if (spec.kind === 'boolean') {
        const parsed = parseBooleanEnv(rawEnv);
        if (parsed !== undefined) { value = parsed; source = 'env'; }
        else warnings.push(`${spec.env}="${rawEnv}" is not a boolean (use 1/0/true/false); ignoring it.`);
      } else if (spec.kind === 'number') {
        const parsed = Number(rawEnv);
        if (Number.isFinite(parsed)) { value = parsed; source = 'env'; }
        else warnings.push(`${spec.env}="${rawEnv}" is not a number; ignoring it.`);
      } else {
        value = rawEnv;
        source = 'env';
      }
    }

    (values as any)[key] = value;
    sources[key] = source;
  }

  return { values, sources, warnings, configPath };
}

/**
 * Project file-config values onto the environment variables the rest of the
 * codebase reads. Only keys sourced from the file are written, and only when
 * the env var is unset — the environment always wins.
 */
export function applyConfigToEnv(
  resolved: ResolvedConfig = resolveConfig(),
  env: Record<string, string | undefined> = process.env
): ResolvedConfig {
  for (const [key, spec] of Object.entries(CONFIG_KEYS) as Array<[keyof SpliceConfigValues, KeySpec]>) {
    if (resolved.sources[key] !== 'file') continue;
    if (env[spec.env] !== undefined && env[spec.env] !== '') continue;
    const value = resolved.values[key];
    if (value === undefined) continue;
    env[spec.env] = spec.kind === 'boolean' ? (value ? '1' : '0') : String(value);
  }
  for (const warning of resolved.warnings) {
    console.error(`[Splice Config] ${warning}`);
  }
  return resolved;
}

/**
 * Side effect on import: apply the discovered config file to process.env so
 * every module — regardless of import order — sees the same environment.
 */
export const activeConfig: ResolvedConfig = applyConfigToEnv();
