#!/usr/bin/env bash
# Mongo backup script (S4-3).
# Usage:
#   MONGO_URI=mongodb://mongo:27017/?replicaSet=rs0 ./backup-mongo.sh
#   Override defaults with NW_BACKUP_DIR, NW_BACKUP_KEEP_DAYS.
# Compatible with cron / pm2 sidecar / docker exec.
# Recommended production crontab (daily at 2am):
#   0 2 * * * /app/deploy/backup-mongo.sh >> /var/log/nw-backup.log 2>&1

set -euo pipefail

MONGO_URI="${MONGO_URI:-mongodb://localhost:27017/?replicaSet=rs0}"
BACKUP_DIR="${NW_BACKUP_DIR:-/backups/mongo}"
KEEP_DAYS="${NW_BACKUP_KEEP_DAYS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DUMP_NAME="dump_${TIMESTAMP}"
DUMP_PATH="${BACKUP_DIR}/${DUMP_NAME}"
ARCHIVE="${DUMP_PATH}.tar.gz"

mkdir -p "${BACKUP_DIR}"

echo "[$(date -u +%FT%TZ)] Starting mongodump → ${ARCHIVE}"
mongodump --uri="${MONGO_URI}" --out="${DUMP_PATH}"
tar -czf "${ARCHIVE}" -C "${BACKUP_DIR}" "${DUMP_NAME}"
rm -rf "${DUMP_PATH}"

# Optional: upload to object storage (activated by setting NW_BACKUP_S3_BUCKET)
if [[ -n "${NW_BACKUP_S3_BUCKET:-}" ]]; then
  echo "[$(date -u +%FT%TZ)] Uploading to s3://${NW_BACKUP_S3_BUCKET}/"
  aws s3 cp "${ARCHIVE}" "s3://${NW_BACKUP_S3_BUCKET}/${DUMP_NAME}.tar.gz"
fi

# Remove local backups older than the retention period
find "${BACKUP_DIR}" -name "dump_*.tar.gz" -mtime +"${KEEP_DAYS}" -delete
echo "[$(date -u +%FT%TZ)] Done. Kept backups from last ${KEEP_DAYS} days."
