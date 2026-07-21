#!/usr/bin/env bash
# Deprecates the ssh-era 0.1.0 publishes. Usage: scripts/deprecate-0.1.0.sh <otp>
set -euo pipefail
OTP="${1:?usage: deprecate-0.1.0.sh <otp-code>}"
for p in orc-core orc-executors orc-harness-claude orc-harness-codex orc-ui orc-ops orc-sdk orc-mcp orc-cli; do
  npm deprecate "@karowanorg/$p@0.1.0" "published from pre-ssh-removal code; use 0.1.1" --otp "$OTP" \
    && echo "deprecated @karowanorg/$p@0.1.0"
done
