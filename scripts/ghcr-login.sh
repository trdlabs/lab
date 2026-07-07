#!/usr/bin/env bash
# Log Docker into ghcr.io using the GitHub CLI token.
# Required once per machine when pulling private org packages (trdlabs/*).
#
# Prerequisite (one-time, interactive — opens browser):
#   gh auth refresh -h github.com -s read:packages
set -euo pipefail

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI not found — install: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Not logged in — run: gh auth login" >&2
  exit 1
fi

scopes="$(gh auth status 2>&1 | sed -n 's/.*Token scopes: //p' | head -1)"
if [[ "${scopes:-}" != *read:packages* ]]; then
  echo "Missing read:packages on gh token. Run (interactive):" >&2
  echo "  gh auth refresh -h github.com -s read:packages" >&2
  exit 1
fi

user="$(gh api user -q .login)"
echo "$(
  gh auth token
)" | docker login ghcr.io -u "$user" --password-stdin
echo "OK — docker can pull private ghcr.io/trdlabs/* packages as $user"
