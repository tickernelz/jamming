<?php
// QA: wipe all ephemeral session data (keeps users).
$db = new PDO('sqlite:' . __DIR__ . '/../../data/jamri.sqlite');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('PRAGMA foreign_keys = ON');
foreach (['world_boxes', 'room_queue', 'room_playlist', 'chat_messages', 'room_access', 'stream_cache', 'rooms'] as $tbl) {
    $db->exec("DELETE FROM \"$tbl\"");
}
echo 'rooms=' . $db->query('SELECT COUNT(*) c FROM rooms')->fetch()['c']
    . ' boxes=' . $db->query('SELECT COUNT(*) c FROM world_boxes')->fetch()['c']
    . ' users=' . $db->query('SELECT COUNT(*) c FROM users')->fetch()['c'] . PHP_EOL;
