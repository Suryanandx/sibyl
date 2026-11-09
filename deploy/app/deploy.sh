#!/usr/bin/env bash
# Runs on the app host (sent by the "App" workflow through AWS Systems Manager).
#   deploy.sh <image-tag> <registry>
# Writes settings from SSM Parameter Store, backs up the database, starts the
# new images, waits for health, and rolls back to the previous tag if needed.
set -euo pipefail

TAG="$1"; REGISTRY="$2"
DIR=/srv/sibyl/release; REGION=eu-central-1
cd "$DIR"

TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H "X-aws-ec2-metadata-token-ttl-seconds: 60")
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4)

umask 077
aws ssm get-parameter --region "$REGION" --name /sibyl/prod/env --with-decryption --query Parameter.Value --output text > /srv/sibyl/.env
aws ssm get-parameter --region "$REGION" --name /sibyl/prod/livekit-env --with-decryption --query Parameter.Value --output text > /srv/sibyl/livekit.env 2>/dev/null || : > /srv/sibyl/livekit.env
ACME_EMAIL=$(aws ssm get-parameter --region "$REGION" --name /sibyl/prod/acme-email --query Parameter.Value --output text)
umask 022

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null

PREV=$(cat /srv/sibyl/current-tag 2>/dev/null || true)
export REGISTRY PUBLIC_IP ACME_EMAIL
PROFILES="--profile realtime"

up() {
  IMAGE_TAG="$1" docker compose $PROFILES pull --quiet
  IMAGE_TAG="$1" docker compose $PROFILES up -d --remove-orphans
}

healthy() {
  for _ in $(seq 1 30); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' sibyl-gateway-1 2>/dev/null)" = healthy ] && return 0
    sleep 5
  done
  return 1
}

# Online backup of the database before any schema change can touch it.
if [ -f /srv/sibyl/data/sibyl.db ]; then
  mkdir -p /srv/sibyl/backups
  docker run --rm -v /srv/sibyl/data:/d -v /srv/sibyl/backups:/b keinos/sqlite3:3.46.1 \
    sqlite3 /d/sibyl.db ".backup /b/sibyl-$(date -u +%Y%m%dT%H%M%SZ)-${PREV:-none}.db"
  ls -1t /srv/sibyl/backups/*.db | tail -n +15 | xargs -r rm --
fi

up "$TAG"
if healthy; then
  echo "$TAG" > /srv/sibyl/current-tag
  docker image prune -af --filter "until=168h" >/dev/null
  echo "deployed $TAG"
else
  echo "gateway not healthy on $TAG" >&2
  if [ -n "$PREV" ]; then up "$PREV"; healthy && echo "rolled back to $PREV" >&2; fi
  exit 1
fi
