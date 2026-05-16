# Security Policy

## Supported Versions

Security fixes are provided for the latest release on the `main` branch.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities. Email the maintainers with:

- A short description of the issue
- Steps to reproduce
- Potential impact
- Any suggested remediation

We will acknowledge reports as quickly as possible and coordinate disclosure once a fix is available.

## Security Expectations

Splice handles browser sessions, telemetry, storage state, and agent-facing page content. Contributions must avoid:

- Exposing secrets in logs, reports, snapshots, or semantic trees
- Adding arbitrary code execution tools without an explicit sandbox and opt-in controls
- Weakening prompt-injection redaction or exfiltration checks
- Writing snapshot or trace files outside the configured `.splice` workspace
