#!/usr/bin/env node
/**
 * Splice CLI — launch and configure without hand-editing env vars or MCP JSON.
 *
 *   splice start [--openclaw] [--dashboard] [--watch]   run the MCP server (stdio)
 *   splice init  [--force] [--openclaw] [--dashboard]   scaffold splice.config.json + client snippets
 *   splice doctor [--json]                              verify the environment end to end
 *   splice config [--json]                              print the effective config and where each value came from
 *
 * The server itself stays importable and launchable as dist/index.js — this
 * CLI is a convenience layer on top, not a new contract.
 */

import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
// activeConfig is the resolution captured BEFORE the config file was projected
// onto process.env — re-resolving here would misattribute file values to env.
import { activeConfig, CONFIG_KEYS, type SpliceConfigValues } from './config.js';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

function packageVersion(): string {
  // dist/cli.js → ../package.json; dist_test/src/cli.js → ../../package.json.
  for (const candidate of ['..', '../..'].map((up) => path.join(moduleDir, up, 'package.json'))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (parsed?.name === 'splice') return parsed.version ?? 'unknown';
    } catch { /* keep looking */ }
  }
  return 'unknown';
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';
const tty = process.stdout.isTTY === true;
const paint = (code: string, text: string) => (tty ? `${code}${text}${RESET}` : text);

function printHelp(): void {
  console.log(`${paint(BOLD, 'Splice')} — browser cognition infrastructure for autonomous agents (v${packageVersion()})

Usage: splice <command> [flags]

Commands:
  start     Run the MCP server over stdio (what your MCP client launches).
              --openclaw    also start the OpenClaw WebSocket gateway
              --dashboard   auto-open the Command Center on startup
              --watch       visible Chromium window instead of headless
  init      Scaffold splice.config.json here and print ready-to-paste
            MCP client snippets (Claude Code, Claude Desktop, Cursor).
              --force       overwrite an existing splice.config.json
              --openclaw / --dashboard / --watch  enable in the generated file
  doctor    Check Node, the build, Chromium, ports, and config health.
              --json        machine-readable report
  config    Show the effective configuration and each value's source.
              --json        machine-readable output

Configuration is layered: environment variables override splice.config.json,
which overrides defaults. Discovery order: $SPLICE_CONFIG, ./splice.config.json,
~/.splice/config.json. Secrets (SPLICE_ENCRYPTION_KEY) are env-only.`);
}

// ─── splice start ────────────────────────────────────────────────────────────

async function commandStart(args: string[]): Promise<void> {
  if (hasFlag(args, '--openclaw')) process.env.SPLICE_ENABLE_OPENCLAW = '1';
  if (hasFlag(args, '--dashboard')) process.env.SPLICE_AUTO_OPEN_DASHBOARD = '1';
  if (hasFlag(args, '--watch')) process.env.SPLICE_WATCH_MODE = '1';
  // index.js boots the server on import; config.js (already imported) has
  // applied any config file to the environment.
  await import('./index.js');
}

// ─── splice init ─────────────────────────────────────────────────────────────

function commandInit(args: string[]): void {
  const target = path.join(process.cwd(), 'splice.config.json');
  if (fs.existsSync(target) && !hasFlag(args, '--force')) {
    console.error(`${paint(RED, 'refused:')} ${target} already exists. Re-run with --force to overwrite.`);
    process.exitCode = 1;
    return;
  }

  const config: Record<string, unknown> = {
    autoOpenDashboard: hasFlag(args, '--dashboard'),
    enableOpenClaw: hasFlag(args, '--openclaw'),
    openclawGatewayPort: CONFIG_KEYS.openclawGatewayPort.default,
    bridgePort: CONFIG_KEYS.bridgePort.default,
    watchMode: hasFlag(args, '--watch'),
  };
  fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n');

  const serverPath = path.join(moduleDir, 'index.js');
  const desktopSnippet = {
    mcpServers: {
      splice: { command: 'node', args: [serverPath] },
    },
  };

  console.log(`${paint(GREEN, 'created')} ${target}

${paint(BOLD, 'Wire Splice into your MCP client:')}

${paint(CYAN, 'Claude Code')}
  claude mcp add splice -- node ${serverPath}

${paint(CYAN, 'Claude Desktop')} ${paint(DIM, '(claude_desktop_config.json)')} / ${paint(CYAN, 'Cursor')} ${paint(DIM, '(.cursor/mcp.json)')}
${JSON.stringify(desktopSnippet, null, 2)}

${paint(BOLD, 'Next steps:')}
  splice doctor   ${paint(DIM, '# verify Chromium, ports, and config health')}
  splice config   ${paint(DIM, '# see the effective configuration')}

Edit splice.config.json to change behavior — no env vars needed. Env vars
still win when set (see README → Environment Variables).`);
}

// ─── splice doctor ───────────────────────────────────────────────────────────

interface DoctorCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.listen({ port, host: '127.0.0.1' }, () => probe.close(() => resolve(true)));
  });
}

async function commandDoctor(args: string[]): Promise<void> {
  const checks: DoctorCheck[] = [];
  const resolved = activeConfig;

  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= 20
      ? { name: 'Node.js runtime', status: 'pass', detail: `v${process.versions.node}` }
      : { name: 'Node.js runtime', status: 'fail', detail: `v${process.versions.node} — Splice needs Node 20+`, fix: 'Install Node 20 or newer.' }
  );

  const serverPath = path.join(moduleDir, 'index.js');
  checks.push(
    fs.existsSync(serverPath)
      ? { name: 'Compiled server', status: 'pass', detail: serverPath }
      : { name: 'Compiled server', status: 'fail', detail: `${serverPath} not found`, fix: 'Run: npm run build' }
  );

  try {
    const { chromium } = await import('playwright');
    const executable = chromium.executablePath();
    checks.push(
      executable && fs.existsSync(executable)
        ? { name: 'Chromium browser', status: 'pass', detail: executable }
        : { name: 'Chromium browser', status: 'fail', detail: 'Playwright Chromium is not installed', fix: 'Run: npx playwright install chromium' }
    );
  } catch (e: any) {
    checks.push({ name: 'Chromium browser', status: 'fail', detail: `playwright not loadable: ${e?.message ?? e}`, fix: 'Run: npm install' });
  }

  try {
    const spliceDir = path.join(process.cwd(), '.splice');
    fs.mkdirSync(spliceDir, { recursive: true });
    const probe = path.join(spliceDir, `.doctor-probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    checks.push({ name: 'Workspace (.splice)', status: 'pass', detail: `${spliceDir} is writable` });
  } catch (e: any) {
    checks.push({ name: 'Workspace (.splice)', status: 'fail', detail: `cannot write ${path.join(process.cwd(), '.splice')}: ${e?.message ?? e}`, fix: 'Run Splice from a directory you can write to.' });
  }

  const dashboardCandidates = [
    path.join(moduleDir, '..', 'dashboard', 'index.html'),
    path.join(moduleDir, '..', '..', 'dashboard', 'index.html'),
    path.join(process.cwd(), 'dashboard', 'index.html'),
  ];
  const dashboard = dashboardCandidates.find((p) => fs.existsSync(p));
  checks.push(
    dashboard
      ? { name: 'Command Center template', status: 'pass', detail: dashboard }
      : { name: 'Command Center template', status: 'warn', detail: 'dashboard/index.html not found — reports cannot be generated', fix: 'Run from the Splice package/repo root.' }
  );

  if (resolved.configPath) {
    checks.push(
      resolved.warnings.length === 0
        ? { name: 'Config file', status: 'pass', detail: resolved.configPath }
        : { name: 'Config file', status: 'warn', detail: `${resolved.configPath}: ${resolved.warnings.join(' ')}` }
    );
  } else {
    checks.push({ name: 'Config file', status: 'pass', detail: 'none found — using defaults + env (run `splice init` to create one)' });
  }

  const keyPath = path.join(process.cwd(), '.splice', '.key');
  checks.push({
    name: 'Encryption vault',
    status: 'pass',
    detail: process.env.SPLICE_ENCRYPTION_KEY
      ? 'key provided via SPLICE_ENCRYPTION_KEY'
      : fs.existsSync(keyPath)
        ? `key file present (${keyPath})`
        : 'no key yet — one is auto-generated on first launch',
  });

  if (resolved.values.enableOpenClaw) {
    const free = await portFree(resolved.values.openclawGatewayPort);
    checks.push(
      free
        ? { name: 'OpenClaw gateway port', status: 'pass', detail: `127.0.0.1:${resolved.values.openclawGatewayPort} is free` }
        : { name: 'OpenClaw gateway port', status: 'fail', detail: `port ${resolved.values.openclawGatewayPort} is already in use`, fix: 'Change openclawGatewayPort in splice.config.json or stop the other process.' }
    );
  }

  const failed = checks.filter((c) => c.status === 'fail');

  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify({ version: packageVersion(), healthy: failed.length === 0, checks }, null, 2));
  } else {
    console.log(`${paint(BOLD, 'Splice Doctor')} v${packageVersion()}\n`);
    for (const check of checks) {
      const badge =
        check.status === 'pass' ? paint(GREEN, ' PASS ')
        : check.status === 'warn' ? paint(YELLOW, ' WARN ')
        : paint(RED, ' FAIL ');
      console.log(`${badge} ${paint(BOLD, check.name.padEnd(24))} ${check.detail}`);
      if (check.fix) console.log(`        ${paint(DIM, `fix: ${check.fix}`)}`);
    }
    console.log(
      failed.length === 0
        ? `\n${paint(GREEN, 'Ready.')} Launch with: splice start`
        : `\n${paint(RED, `${failed.length} check(s) failed.`)} Fix the items above and re-run splice doctor.`
    );
  }
  if (failed.length > 0) process.exitCode = 1;
}

// ─── splice config ───────────────────────────────────────────────────────────

function commandConfig(args: string[]): void {
  const resolved = activeConfig;
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }
  console.log(`${paint(BOLD, 'Effective configuration')} ${paint(DIM, resolved.configPath ? `(file: ${resolved.configPath})` : '(no config file — defaults + env)')}\n`);
  for (const key of Object.keys(CONFIG_KEYS) as Array<keyof SpliceConfigValues>) {
    const value = resolved.values[key];
    const source = resolved.sources[key];
    const sourceLabel =
      source === 'env' ? paint(CYAN, `env:${CONFIG_KEYS[key].env}`)
      : source === 'file' ? paint(GREEN, 'file')
      : paint(DIM, 'default');
    console.log(`  ${key.padEnd(22)} ${String(value ?? '—').padEnd(28)} ${sourceLabel}`);
  }
  for (const warning of resolved.warnings) {
    console.log(`\n${paint(YELLOW, 'warning:')} ${warning}`);
  }
}

// ─── entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [command = 'start', ...rest] = process.argv.slice(2);
  switch (command) {
    case 'start': return commandStart(rest);
    case 'init': return commandInit(rest);
    case 'doctor': return commandDoctor(rest);
    case 'config': return commandConfig(rest);
    case '--version': case '-v': case 'version':
      console.log(packageVersion());
      return;
    case '--help': case '-h': case 'help':
      printHelp();
      return;
    default:
      console.error(`${paint(RED, `Unknown command: ${command}`)}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Fatal CLI error:', error);
  process.exit(1);
});
