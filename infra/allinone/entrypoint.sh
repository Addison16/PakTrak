#!/bin/sh
# Prepares /data and starts every PakTrak service under supervisord.
set -eu
mkdir -p /data/postgres /data/photos /data/broker /run/paktrak/nginx
chmod 0700 /data/postgres /run/paktrak
python -I /usr/local/lib/paktrak/aio.py
# Moved or restored data can belong to other user IDs; fix it once.
for dir in /data/photos /data/broker; do
  [ "$(stat -c %u "$dir")" = 10001 ] || chown -R paktrak:paktrak "$dir"
done
chown paktrak:paktrak /run/paktrak /run/paktrak/nginx /run/paktrak/nginx.conf
chmod 0600 /run/paktrak/env.sh
. /run/paktrak/env.sh
exec supervisord -c /etc/paktrak/supervisord.conf
