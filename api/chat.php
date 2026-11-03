<?php
// api/chat.php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\RoomManager;

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);

$roomId = trim((string)($_GET['room_id'] ?? ''));
$beforeId = isset($_GET['before_id']) ? (int)$_GET['before_id'] : null;
$limit = min(50, max(5, (int)($_GET['limit'] ?? 10)));

if ($roomId === '') {
    http_response_code(400);
    echo json_encode(['error' => 'room_id is required']);
    exit;
}

$messages = $roomManager->getChatMessages($roomId, $beforeId, $limit);
echo json_encode([
    'success' => true,
    'messages' => $messages,
    'has_more' => count($messages) === $limit,
]);
