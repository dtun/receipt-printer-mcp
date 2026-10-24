# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Remote access from any Claude client, including mobile: a Cloudflare
  Worker (`worker/`) serves `print_receipt` and `printer_status` over remote
  MCP behind Google sign-in limited to `ALLOWED_EMAILS`, and queues jobs in a
  Durable Object.
- Home print agent (`agent/`) that connects out to the Worker and prints
  through the same print script, with a launchd installer for macOS.
- Control characters are stripped from remote text before printing.

### Changed

- Printer logic moved to `lib/` so the local server, Worker, and agent share
  it.

## [0.1.0] - 2026-10-04

### Added

- `print_receipt` tool: prints text on the Rongta RP820 via the
  print-receipt skill's `print.sh`, rejecting lines over 48 columns.
- `printer_status` tool: printer state and pending jobs from `lpstat`.
