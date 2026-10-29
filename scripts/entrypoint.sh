#!/bin/sh
set -eu

cleanup() {
  node /app/dist/scripts/teardown.js || true
}
trap cleanup EXIT

node /app/dist/scripts/setup.js
node /app/dist/e2e/demo.js
