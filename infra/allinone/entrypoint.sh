#!/bin/sh
# Prepares /data and starts every PakTrak service under supervisord.
set -eu
mkdir -p /data/postgres /data/photos /data/broker /data/backups /run/paktrak/nginx
chmod 0700 /data/postgres /run/paktrak
# The services run as their own users, so they must be able to enter /data even
# when the host folder was created private (mode 0700). Traversal alone lists
# nothing, and every entry inside is private to the service that owns it.
chmod a+x /data
# Moved or restored data can belong to other user IDs; fix it once.
for dir in /data/photos /data/broker /data/backups; do
  [ "$(stat -c %u "$dir")" = 10001 ] || chown -R paktrak:paktrak "$dir"
  chmod 0700 "$dir"
done
# A backup chosen in the app, or placed in /data/restore, brings its private
# settings first; startup restores its databases once the database is up.
SCANNER_BACKUP_DIR=/data/backups python -m scanner.backups prepare-restore
python -I /usr/local/lib/paktrak/aio.py
chown paktrak:paktrak /run/paktrak /run/paktrak/nginx /run/paktrak/nginx.conf
chmod 0600 /run/paktrak/env.sh
. /run/paktrak/env.sh
exec supervisord -c /etc/paktrak/supervisord.conf
