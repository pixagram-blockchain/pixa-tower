#!/usr/bin/env bash
# One-command deployment of Pixa Tower to Cloudflare.
#
#   ./deploy.sh staging
#   ./deploy.sh production --access-team <team>.cloudflareaccess.com --access-aud <AUD tag>
#
# First run creates the resources (D1, KV, R2, Queue) and writes their ids into the configs.
# Later runs reuse them. Requires Node 22+ and `npx wrangler login` (or CLOUDFLARE_API_TOKEN).
set -euo pipefail
cd "$(dirname "$0")"

ENV="${1:-}"
if [[ "$ENV" != "staging" && "$ENV" != "production" ]]; then
  echo "usage: ./deploy.sh <staging|production> [--access-team DOMAIN --access-aud AUD] [--skip-tests]"
  exit 1
fi
shift

node --version | grep -qE '^v(2[2-9]|[3-9][0-9])' || { echo "Node 22 or newer is required"; exit 1; }
[[ -d node_modules ]] || npm ci

SETUP_ARGS=()
DEPLOY_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --access-team|--access-aud) SETUP_ARGS+=("$1" "$2"); shift 2 ;;
    *) DEPLOY_ARGS+=("$1"); shift ;;
  esac
done

node scripts/setup.mjs --env "$ENV" "${SETUP_ARGS[@]+"${SETUP_ARGS[@]}"}"
node scripts/deploy.mjs --env "$ENV" "${DEPLOY_ARGS[@]+"${DEPLOY_ARGS[@]}"}"
