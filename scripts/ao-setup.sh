#!/usr/bin/env bash
# Same as ao-setup.ps1 for macOS/Linux/WSL.
set -euo pipefail
cd "$(dirname "$0")/.."
ao status >/dev/null
if ! ao project ls --json | jq -e '.[] | select(.id=="kovario")' >/dev/null; then
  ao project add --path "$PWD" --id kovario --name Kovario --worker-agent claude-code --orchestrator-agent claude-code
fi
ao project set-config kovario --config-json "$(cat ao.project.json)"
ao project get kovario
