#!/usr/bin/env bash
set -euo pipefail

# Create or update a Kubernetes secret named "nimbus-api-key"
# with a single literal key/value: iNIMBUS_API_KEY=$CIRRUS_KEY

if [ -z "${CIRRUS_KEY:-}" ]; then
  echo "ERROR: CIRRUS_KEY is not set. Export CIRRUS_KEY and retry." >&2
  exit 1
fi

SECRET_NAME="nimbus-api-key"
KEY_NAME="NIMBUS_API_KEY"

kubectl create secret generic "$SECRET_NAME" \
  --from-literal="${KEY_NAME}=${CIRRUS_KEY}" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "Secret '$SECRET_NAME' created/updated successfully."
