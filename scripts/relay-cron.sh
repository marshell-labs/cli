#!/bin/sh
# Hermes/cron wrapper — run `marshell relay cron --quiet`
# Install: curl -fsSL https://marshell.dev/scripts/relay-cron.sh -o ~/.hermes/scripts/marshell-relay-cron.sh && chmod +x ~/.hermes/scripts/marshell-relay-cron.sh
# Cron job script path: /root/.hermes/scripts/marshell-relay-cron.sh

set -e
export PATH="/usr/local/bin:/usr/bin:/bin:${HOME}/.hermes/node/bin:${PATH}"

exec marshell relay cron --quiet
