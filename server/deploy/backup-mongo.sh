#!/usr/bin/env bash
# Mongo 备份脚本（S4-3）。
# 用法：
#   MONGO_URI=mongodb://mongo:27017/?replicaSet=rs0 ./backup-mongo.sh
#   可配 NW_BACKUP_DIR、NW_BACKUP_KEEP_DAYS 覆盖默认值。
# 在 cron / pm2 外挂 / docker exec 均可。
# 生产推荐加到 crontab（每日凌晨 2 点）：
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

# 可选：上传到对象存储（填 NW_BACKUP_S3_BUCKET 激活）
if [[ -n "${NW_BACKUP_S3_BUCKET:-}" ]]; then
  echo "[$(date -u +%FT%TZ)] Uploading to s3://${NW_BACKUP_S3_BUCKET}/"
  aws s3 cp "${ARCHIVE}" "s3://${NW_BACKUP_S3_BUCKET}/${DUMP_NAME}.tar.gz"
fi

# 清理超过保留天数的本地备份
find "${BACKUP_DIR}" -name "dump_*.tar.gz" -mtime +"${KEEP_DAYS}" -delete
echo "[$(date -u +%FT%TZ)] Done. Kept backups from last ${KEEP_DAYS} days."
