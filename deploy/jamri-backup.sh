#!/bin/sh
set -eu

db=${JAMRI_DB:-/opt/jamri/data/jamri.sqlite}
dest=${JAMRI_BACKUP_DIR:-/var/backups/jamri}
keep_days=${JAMRI_BACKUP_KEEP_DAYS:-14}

mkdir -p "$dest"
chmod 700 "$dest"
out="$dest/jamri-$(date +%Y%m%d-%H%M%S).sqlite"

php -- "$db" "$out" <<'PHP'
<?php
[, $source, $target] = $argv;
$db = new PDO('sqlite:' . $source, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$db->exec('PRAGMA busy_timeout = 10000');
$db->exec('VACUUM INTO ' . $db->quote($target));
$check = new PDO('sqlite:' . $target, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
if ($check->query('PRAGMA integrity_check')->fetchColumn() !== 'ok') {
    fwrite(STDERR, "integrity_check failed\n");
    exit(1);
}
PHP

gzip -9 "$out"
find "$dest" -name 'jamri-*.sqlite.gz' -type f -mtime "+$keep_days" -delete
echo "backup ok: $out.gz"
