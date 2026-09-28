#!/bin/sh
# Nightly SQLite snapshot, keeping the last 14. `.backup` takes a consistent copy even while the
# app is writing. Scheduled by the deploy user's crontab.
set -eu
cd /opt/kestrel
mkdir -p backups
stamp=$(date -u +%Y-%m-%d)
sqlite3 data/kestrel.db ".backup backups/kestrel-$stamp.db"
gzip -f "backups/kestrel-$stamp.db"
ls -1t backups/kestrel-*.db.gz | tail -n +15 | xargs -r rm --
