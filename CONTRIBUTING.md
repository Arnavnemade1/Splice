# Contributing to Splice

We love your input! We want to make contributing to Splice as easy and transparent as possible, whether it's:

- Reporting a bug
- Discussing the current state of the code
- Submitting a fix
- Proposing new features

## We Develop with GitHub
We use GitHub to host code, to track issues and feature requests, as well as accept pull requests.

## Report bugs using GitHub's issues
We use GitHub issues to track public bugs. Report a bug by opening a new issue; it's that easy!

## Write bug reports with detail, background, and sample code
**Great Bug Reports** tend to have:
- A quick summary and/or background
- Steps to reproduce
- What you expected would happen
- What actually happens
- Notes (possibly including why you think this might be happening, or stuff you tried that didn't work)

## Code Standards
Splice is built specifically for autonomous agents. Because of this, changes to the core MCP server interfaces and HTML extraction logic should heavily prioritize:
1. **Speed & Latency**: Keep token bloat to an absolute minimum in the `SemanticTree`.
2. **Security**: Ensure agents can't be tricked by malicious web pages into executing arbitrary code.

When proposing a pull request, ensure `npm run build` succeeds locally and no new TypeScript compilation errors are introduced.

Thank you for helping us make the web a safer place for agents!
