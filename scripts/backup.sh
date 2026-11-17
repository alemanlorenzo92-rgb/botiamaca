#!/usr/bin/env bash
# Copia de seguridad: base de datos (pg_dump, formato custom) + biblioteca de fotos y videos.
# Uso: DATABASE_URL=... MEDIA_DIR=/data/media ./scripts/backup.sh [carpeta_destino]
# Restaurar: pg_restore --clean --no-owner -d "$DATABASE_URL" db-*.dump && tar -xzf media-*.tar.gz -C "$MEDIA_DIR"
set -euo pipefail
: "${DATABASE_URL:?Falta DATABASE_URL}"
MEDIA_DIR="${MEDIA_DIR:-./data/media}"
DEST="${1:-./backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" --file="$DEST/db-$STAMP.dump"
if [ -d "$MEDIA_DIR" ]; then tar -czf "$DEST/media-$STAMP.tar.gz" -C "$MEDIA_DIR" .; fi
echo "Backup listo en $DEST ($STAMP)"
