#!/usr/bin/env bash
# Wrapper for backup-mongo.sh on the prod VPS: prod Mongo is Atlas (cluster0.rpr2tnw), not a local
# docker-compose mongo container — there's no host mongodump binary and none of the running
# containers bundle one either. Runs the real backup-mongo.sh inside a throwaway official `mongo`
# image (which does bundle mongodump/mongorestore) instead.
#
# Uses `docker run --env-file` (NOT `bash -c 'source .env'`) to avoid shell-expanding any `$`/special
# characters that may appear in the Atlas connection string — bash `source` re-interprets `$...` in
# the file as shell substitution, `docker --env-file` does not.
#
# Deploy-side setup this depends on (VPS-only, not in git — do this once per box):
#   grep '^NW_MONGO_URI=' server/.env | sed 's/^NW_MONGO_URI=/MONGO_URI=/' > server/deploy/.backup-mongo.env
#   chmod 600 server/deploy/.backup-mongo.env
# Deliberately a SEPARATE minimal env file (just MONGO_URI), not --env-file'ing the whole app .env —
# no reason to hand this throwaway container every Stripe/Paddle/WeChat secret too.
#
# Cron (daily at 2am): 0 2 * * * /root/funny/server/deploy/backup-mongo-docker-wrapper.sh >> /var/log/nw-backup.log 2>&1
set -euo pipefail

docker run --rm \
  --env-file /root/funny/server/deploy/.backup-mongo.env \
  -e NW_BACKUP_DIR=/backups/mongo \
  -e NW_BACKUP_KEEP_DAYS=7 \
  -v /root/backups/mongo:/backups/mongo \
  -v /root/funny/server/deploy/backup-mongo.sh:/backup-mongo.sh:ro \
  mongo:7 bash /backup-mongo.sh
