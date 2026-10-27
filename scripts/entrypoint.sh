#!/bin/sh
set -eu

node /app/dist/scripts/setup.js
exec node /app/dist/e2e/demo.js
