<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\PasscodeGate;
use Jamri\RateLimiter;
use Jamri\RoomManager;
use Jamri\UserManager;
use Jamri\Validator;

Http::securityHeaders();

$pdo = Database::getConnection();
$user = Http::requireUser(new UserManager($pdo));
$roomManager = new RoomManager($pdo);
$rateLimiter = RateLimiter::shared();

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
    $outcome = (new PasscodeGate($roomManager, $rateLimiter))->attempt($roomId, $user['device_id'], $passcode, Http::clientKey());
    if ($outcome === PasscodeGate::THROTTLED) {
        Http::error('Terlalu banyak percobaan passcode. Coba lagi 10 menit lagi.', 429);
    }
    if ($outcome === PasscodeGate::INVALID) {
        Http::error('invalid_passcode', 403, $denied);
    }
}

Http::json(['success' => true, 'data' => $roomManager->getRoomDetail($roomId, $user['device_id'])]);
