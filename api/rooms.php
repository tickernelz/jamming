<?php
// api/rooms.php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\RoomManager;
use Jamri\UserManager;

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);
$userManager = new UserManager($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $search = trim((string)($_GET['search'] ?? ''));
    $rooms = $roomManager->getPublicRooms($search);
    echo json_encode(['success' => true, 'rooms' => $rooms]);
    exit;
}

if ($method === 'POST') {
    $input = json_decode(file_get_contents('php://input') ?: '', true) ?? $_POST;
    $action = $input['action'] ?? 'create';

    // Handle add to room playlist (Bank Musik)
    if ($action === 'add_playlist') {
        $roomId = trim((string)($input['room_id'] ?? ''));
        $track = $input['track'] ?? null;
        $deviceId = trim((string)($input['device_id'] ?? ''));
        $user = $deviceId ? $userManager->getUser($deviceId) : null;
        $nickname = $user['nickname'] ?? 'Member';

        if ($roomId !== '' && $track && !empty($track['youtube_id'])) {
            $added = $roomManager->addTrackToPlaylist($roomId, $track, $nickname);
            if ($added === null) {
                echo json_encode(['success' => false, 'error' => 'duplicate', 'message' => 'Lagu sudah ada di Bank Musik']);
                exit;
            }
            echo json_encode(['success' => true, 'data' => $added]);
            exit;
        }

        http_response_code(400);
        echo json_encode(['error' => 'Invalid playlist parameters']);
        exit;
    }

    // Handle remove from room playlist
    if ($action === 'remove_playlist') {
        $roomId = trim((string)($input['room_id'] ?? ''));
        $playlistId = (int)($input['playlist_id'] ?? 0);

        if ($roomId !== '' && $playlistId > 0) {
            $roomManager->removeTrackFromPlaylist($roomId, $playlistId);
            echo json_encode(['success' => true]);
            exit;
        }

        http_response_code(400);
        echo json_encode(['error' => 'Invalid remove playlist parameters']);
        exit;
    }

    $name = trim((string)($input['name'] ?? ''));
    $isPrivate = !empty($input['is_private']);
    $passcode = trim((string)($input['passcode'] ?? ''));
    $deviceId = trim((string)($input['device_id'] ?? ''));

    if ($name === '' || $deviceId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Room name and device_id are required']);
        exit;
    }

    if ($isPrivate && $passcode === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Private rooms require a passcode']);
        exit;
    }

    $user = $userManager->getUser($deviceId);
    if (!$user) {
        $user = $userManager->registerOrUpdate($deviceId, 'Kawan Jamming', '🎧');
    }

    $room = $roomManager->createRoom($name, $isPrivate, $passcode, $deviceId);
    echo json_encode(['success' => true, 'room' => $room]);
    exit;
}
