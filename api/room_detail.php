<?php
// api/room_detail.php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\RoomManager;

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);

$roomId = trim((string)($_GET['room_id'] ?? ''));
$passcode = trim((string)($_GET['passcode'] ?? ''));

if ($roomId === '') {
    http_response_code(400);
    echo json_encode(['error' => 'room_id is required']);
    exit;
}

$detail = $roomManager->getRoomDetail($roomId, $passcode ?: null);

if (!$detail) {
    http_response_code(404);
    echo json_encode(['error' => 'Room not found or has expired']);
    exit;
}

if (isset($detail['error']) && $detail['error'] === 'invalid_passcode') {
    http_response_code(403);
    echo json_encode(['error' => 'invalid_passcode', 'message' => 'Passcode room salah.', 'room' => $detail['room']]);
    exit;
}

echo json_encode(['success' => true, 'data' => $detail]);
