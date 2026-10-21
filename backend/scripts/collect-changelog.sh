#!/bin/sh
# One canonical Coolify scheduled task. Keep this mount stable across deployments.
set -eu
umask 077
exec flock -n /var/lib/financio-trust-automation/collector.lock node /app/dist/cli/collectChangelog.js
