<?php
// api/rooms.php

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
$roomManager = new RoomManager($pdo);
$userManager = new UserManager($pdo);
$rateLimiter = new RateLimiter();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $search = Validator::clean($_GET['search'] ?? '', 60);
    $rooms = $roomManager->getPublicRooms($search);
    Http::json(['success' => true, 'rooms' => $rooms]);
}

if ($method === 'POST') {
    $input = Http::input();
    $action = is_string($input['action'] ?? null) ? $input['action'] : 'create';
    $deviceId = Validator::deviceId($input['device_id'] ?? '');

    // Handle add to room playlist (Bank Musik)
    if ($action === 'add_playlist') {
        $roomId = Validator::roomId($input['room_id'] ?? '');
        $track = Validator::track(is_array($input['track'] ?? null) ? $input['track'] : []);
        $user = $deviceId !== '' ? $userManager->getUser($deviceId) : null;
        $nickname = $user['nickname'] ?? 'Member';

        if ($roomId !== '' && $track !== null) {
            if (!$rateLimiter->allow(RateLimiter::key('playlist_add', Http::clientKey($deviceId)), 30, 60)) {
                Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
            }
            $added = $roomManager->addTrackToPlaylist($roomId, $track, $nickname);
            if ($added === null) {
                Http::json(['success' => false, 'error' => 'duplicate', 'message' => 'Lagu sudah ada di Bank Musik']);
            }
            Http::json(['success' => true, 'data' => $added]);
        }

        Http::error('Invalid playlist parameters', 400);
    }

    // Handle remove from room playlist
    if ($action === 'remove_playlist') {
        $roomId = Validator::roomId($input['room_id'] ?? '');
        $playlistId = (int)($input['playlist_id'] ?? 0);

        if ($roomId !== '' && $playlistId > 0) {
            $roomManager->removeTrackFromPlaylist($roomId, $playlistId);
            Http::json(['success' => true]);
        }

        Http::error('Invalid remove playlist parameters', 400);
    }

    $name = Validator::roomName($input['name'] ?? '');
    $isPrivate = !empty($input['is_private']);
    $passcode = Validator::passcode($input['passcode'] ?? '');

    if ($name === '' || $deviceId === '') {
        Http::error('Room name and device_id are required', 400);
    }

    if ($isPrivate && $passcode === '') {
        Http::error('Private rooms require a passcode', 400);
    }

    // Anti-abuse: cap room creation per device.
    if (!$rateLimiter->allow(RateLimiter::key('room_create', $deviceId), 5, 300)) {
        Http::error('Terlalu banyak room dibuat. Coba lagi nanti.', 429);
    }

    $user = $userManager->getUser($deviceId);
    if (!$user) {
        $user = $userManager->registerOrUpdate($deviceId, 'Kawan Jamming', '🎧');
    }

    $room = $roomManager->createRoom($name, $isPrivate, $passcode, $deviceId);
    Http::json(['success' => true, 'room' => $room]);
}

Http::error('Method not allowed', 405);
