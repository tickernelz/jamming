<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\RoomManager;
use Jamri\UserManager;
use Jamri\Validator;

Http::securityHeaders();

$pdo = Database::getConnection();
$user = Http::requireUser(new UserManager($pdo));
$roomManager = new RoomManager($pdo);
$rateLimiter = new RateLimiter();

$roomId = Validator::roomId($_GET['room_id'] ?? '');
if ($roomId === '') {
    Http::error('room_id is required', 400);
}

if (!$rateLimiter->allow(RateLimiter::key('room_detail', $user['device_id']), 60, 60)) {
    Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
}

$summary = $roomManager->getRoomSummary($roomId);
if (!$summary) {
    Http::error('Room not found or has expired', 404);
}

if (!$roomManager->canAccess($roomId, $user['device_id'])) {
    $denied = ['error' => 'invalid_passcode', 'message' => 'Passcode room salah.', 'room' => ['id' => $summary['id'], 'name' => $summary['name'], 'is_private' => 1]];
    $passcode = $_SERVER['REQUEST_METHOD'] === 'POST' ? (string)(Http::input()['passcode'] ?? '') : '';
    if ($passcode === '') {
        Http::error('invalid_passcode', 403, $denied);
    }
    if (
        !$rateLimiter->allow(RateLimiter::key('passcode_ip', Http::clientKey()), 20, 600)
        || !$rateLimiter->allow(RateLimiter::key('passcode_room', $roomId . '|' . Http::clientKey()), 8, 600)
    ) {
        Http::error('Terlalu banyak percobaan passcode. Coba lagi 10 menit lagi.', 429);
    }
    if (!$roomManager->verifyPasscode($roomId, $passcode)) {
        Http::error('invalid_passcode', 403, $denied);
    }
    $roomManager->grantAccess($roomId, $user['device_id']);
}

Http::json(['success' => true, 'data' => $roomManager->getRoomDetail($roomId, $user['device_id'])]);
