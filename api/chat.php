<?php
// api/chat.php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\RoomManager;
use Jamri\Validator;

Http::securityHeaders();

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);
$rateLimiter = new RateLimiter();

$roomId = Validator::roomId($_GET['room_id'] ?? '');
$beforeId = isset($_GET['before_id']) ? max(0, (int)$_GET['before_id']) : null;
$limit = min(50, max(5, (int)($_GET['limit'] ?? 10)));

if ($roomId === '') {
    Http::error('room_id is required', 400);
}

// Chat history is cheap per call but should still not be enumerable at will.
if (!$rateLimiter->allow(RateLimiter::key('chat_read', Http::clientKey()), 60, 60)) {
    Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
}

$messages = $roomManager->getChatMessages($roomId, $beforeId, $limit);
Http::json([
    'success' => true,
    'messages' => $messages,
    'has_more' => count($messages) === $limit,
]);
