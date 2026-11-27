#!/usr/bin/env bash
# Backup smoke test against the Helm chart in a kind cluster (CI, FP-38): proves the chart's Role
# allows what a backup needs (Secrets by name, the settings and their status). Signs in as the
# initial admin, downloads a backup and opens it with gpg, and records a failed S3 run in the status.
# Usage: scripts/backup-smoke.sh [namespace]
set -euo pipefail
NS="${1:-capi-navigator-system}"
PORT=8090
WORK="$(mktemp -d)"
chmod 700 "$WORK"
kubectl -n "$NS" port-forward svc/capi-navigator "$PORT:80" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true; rm -rf "$WORK"' EXIT
B="http://localhost:$PORT"
H='x-capi-navigator: 1'
for _ in $(seq 1 20); do curl -fsS -m 2 "$B/readyz" >/dev/null 2>&1 && break; sleep 1; done

PW="$(kubectl -n "$NS" get secret capi-navigator-initial-admin -o jsonpath='{.data.password}' | base64 -d)"
NEW="Smoke-$(openssl rand -hex 12)"
api() { curl -fsS -b "$WORK/jar" -c "$WORK/jar" -H "$H" -H 'Content-Type: application/json' "$@"; }
api -o /dev/null "$B/api/auth/login" --data "$(jq -n --arg p "$PW" '{username:"admin",password:$p}')"
api -o /dev/null "$B/api/auth/change-password" \
  --data "$(jq -n --arg o "$PW" --arg n "$NEW" '{currentPassword:$o,newPassword:$n}')"

G="$WORK/gnupg"
mkdir -m 700 "$G"
gpg --homedir "$G" --batch --pinentry-mode loopback --passphrase '' \
  --quick-gen-key smoke@example.com future-default default 1d 2>/dev/null
gpg --homedir "$G" --armor --export smoke@example.com >"$WORK/key.asc"
api -X PUT -o /dev/null "$B/api/backup/settings" \
  --data "$(jq -n --rawfile k "$WORK/key.asc" '{recipients:[{publicKey:$k}],includeAuditEvents:true}')"

api -X POST -o "$WORK/backup.gpg" "$B/api/backup"
gpg --homedir "$G" --batch --pinentry-mode loopback --passphrase '' -d "$WORK/backup.gpg" 2>/dev/null |
  tar tz >"$WORK/files"
grep -qx 'manifest.json' "$WORK/files"
grep -q 'resources/.*-secrets.yaml' "$WORK/files"
echo "backup download: $(wc -l <"$WORK/files") files"

# An unreachable target: the run fails, but must be recorded in the status (status RBAC).
api -X PUT -o /dev/null "$B/api/backup/settings" --data "$(jq -n --rawfile k "$WORK/key.asc" '{
  recipients:[{publicKey:$k}], includeAuditEvents:true,
  s3:{bucket:"smoke-test",endpoint:"http://127.0.0.1:9",forcePathStyle:true},
  s3Credentials:{accessKeyId:"smoke",secretAccessKey:"smoke-secret"}}')"
code="$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/jar" -H "$H" -X POST "$B/api/backup/s3/run")"
[ "$code" = 502 ] || { echo "expected 502 from the S3 run, got $code"; exit 1; }
api "$B/api/backup/settings" | jq -e '.runs[0].outcome == "failure"' >/dev/null
echo "S3 run recorded in the status"
