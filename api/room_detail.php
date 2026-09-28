<?php
// api/room_detail.php

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
$passcode = Validator::passcode($_GET['passcode'] ?? '');

if ($roomId === '') {
    Http::error('room_id is required', 400);
}

// Throttle passcode attempts to make brute-forcing impractical.
if (!$rateLimiter->allow(RateLimiter::key('room_detail', Http::clientKey()), 30, 60)) {
    Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
}

$detail = $roomManager->getRoomDetail($roomId, $passcode !== '' ? $passcode : null);

if (!$detail) {
    Http::error('Room not found or has expired', 404);
}

if (isset($detail['error']) && $detail['error'] === 'invalid_passcode') {
    Http::json(['success' => false, 'error' => 'invalid_passcode', 'message' => 'Passcode room salah.', 'room' => $detail['room']], 403);
}

Http::json(['success' => true, 'data' => $detail]);
