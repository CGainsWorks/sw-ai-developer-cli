#!/usr/bin/env bash
#
# One-time setup for a clean checkout.
#
# Installs dependencies, builds, and runs the offline demo so the checkout is
# verified end to end before anyone reaches for an API key.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REQUIRED_MAJOR=20

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node ${REQUIRED_MAJOR} or newer: https://nodejs.org" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "${NODE_MAJOR}" -lt "${REQUIRED_MAJOR}" ]; then
  echo "Node ${NODE_MAJOR} is too old. This project needs Node ${REQUIRED_MAJOR} or newer." >&2
  exit 1
fi

echo "==> Installing dependencies"
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo
echo "==> Building"
npm run build

echo
echo "==> Running the offline demo"
npm run demo

cat <<'EOF'

Setup complete.

To use a real model, pick a provider:

  export OPENAI_API_KEY=...      # then: swai review --staged
  ollama serve                   # then: swai --provider compat review --staged
                                 # (local model, no key, code stays on this machine)

Run `node bin/swai.js --help` for the full command list, or `npm link` to put
`swai` on your PATH.
EOF
