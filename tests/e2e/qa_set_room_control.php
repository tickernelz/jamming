<?php
// QA helper: set rooms.box_control for a room. Usage: php qa_set_room_control.php <room_id> <owner|everyone>
[$_, $roomId, $mode] = $argv + [null, null, null];
if (!$roomId || !in_array($mode, ['owner', 'everyone'], true)) {
    fwrite(STDERR, "usage: php qa_set_room_control.php <room_id> <owner|everyone>\n");
    exit(2);
}
$db = new PDO('sqlite:' . __DIR__ . '/../../data/jamri.sqlite');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$stmt = $db->prepare('UPDATE rooms SET box_control = :m WHERE id = :id');
$stmt->execute([':m' => $mode, ':id' => $roomId]);
echo "box_control={$mode} rows={$stmt->rowCount()}\n";
