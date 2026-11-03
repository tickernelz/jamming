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
$roomManager = new RoomManager($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $search = Validator::clean($_GET['search'] ?? '', 60);
    $rooms = array_map(static fn (array $room): array => $roomManager->publicView($room), $roomManager->getPublicRooms($search));
    Http::json(['success' => true, 'rooms' => $rooms]);
}

if ($method !== 'POST') {
    Http::error('Method not allowed', 405);
}

$user = Http::requireUser(new UserManager($pdo));
$deviceId = $user['device_id'];
$rateLimiter = new RateLimiter();
$input = Http::input();
$action = is_string($input['action'] ?? null) ? $input['action'] : 'create';

if ($action === 'add_playlist' || $action === 'remove_playlist') {
    $roomId = Validator::roomId($input['room_id'] ?? '');
    $room = $roomId !== '' ? $roomManager->getRoomSummary($roomId) : null;
    if ($room === null || !$roomManager->canAccess($roomId, $deviceId)) {
        Http::error('forbidden', 403);
    }
    if ($room['host_device_id'] !== $deviceId && ($room['box_control'] ?? 'owner') !== 'everyone') {
        Http::error('host_only', 403, ['message' => 'Hanya host yang bisa mengatur Bank Musik.']);
    }
    if (!$rateLimiter->allow(RateLimiter::key('playlist_add', $deviceId), 30, 60)) {
        Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
    }

    if ($action === 'add_playlist') {
        $track = Validator::track(is_array($input['track'] ?? null) ? $input['track'] : []);
        if ($track === null) {
            Http::error('Invalid playlist parameters', 400);
        }
        $added = $roomManager->addTrackToPlaylist($roomId, $track, $user['nickname']);
        if ($added === null) {
            Http::json(['success' => false, 'error' => 'duplicate', 'message' => 'Lagu sudah ada di Bank Musik']);
        }
        Http::json(['success' => true, 'data' => $added]);
    }

    $playlistId = (int)($input['playlist_id'] ?? 0);
    if ($playlistId <= 0) {
        Http::error('Invalid remove playlist parameters', 400);
    }
    $roomManager->removeTrackFromPlaylist($roomId, $playlistId);
    Http::json(['success' => true]);
}

$name = Validator::roomName($input['name'] ?? '');
$isPrivate = !empty($input['is_private']);
$passcode = Validator::passcode($input['passcode'] ?? '');

if ($name === '') {
    Http::error('Room name is required', 400);
}

if ($isPrivate && mb_strlen($passcode) < 4) {
    Http::error('Passcode room private minimal 4 karakter.', 400);
}

if (
    !$rateLimiter->allow(RateLimiter::key('room_create', $deviceId), 5, 300)
    || !$rateLimiter->allow(RateLimiter::key('room_create_ip', Http::clientKey()), 20, 3600)
) {
    Http::error('Terlalu banyak room dibuat. Coba lagi nanti.', 429);
}

$room = $roomManager->createRoom($name, $isPrivate, $passcode, $deviceId, 'legacy', null, null, 'owner');
Http::json(['success' => true, 'room' => $room]);
