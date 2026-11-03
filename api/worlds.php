<?php
// api/worlds.php
// Create and list "world" rooms (pixel jamming worlds). Phase 1: presence only.

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\RoomManager;
use Jamri\UserManager;
use Jamri\Validator;
use Jamri\WorldManager;

Http::securityHeaders();

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);
$userManager = new UserManager($pdo);
$rateLimiter = new RateLimiter();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $pdo->prepare("
        SELECT r.id, r.name, r.created_at, r.host_device_id,
               u.nickname AS host_nickname, u.emoji AS host_emoji
        FROM rooms r
        LEFT JOIN users u ON u.device_id = r.host_device_id
        WHERE r.mode = 'world'
        ORDER BY r.created_at DESC
        LIMIT 50
    ");
    $stmt->execute();
    $worlds = $stmt->fetchAll();

    Http::json([
        'success' => true,
        'worlds' => $worlds,
        'max_users' => WorldManager::MAX_USERS_PER_WORLD,
    ]);
}

if ($method === 'POST') {
    $input = Http::input();
    $name = Validator::roomName($input['name'] ?? '');
    $deviceId = Validator::deviceId($input['device_id'] ?? '');

    if ($name === '' || $deviceId === '') {
        Http::error('Nama world dan device_id diperlukan.', 400);
    }

    if (!$rateLimiter->allow(RateLimiter::key('world_create', $deviceId), 5, 300)) {
        Http::error('Terlalu banyak world dibuat. Coba lagi nanti.', 429);
    }

    if (!$userManager->getUser($deviceId)) {
        $userManager->registerOrUpdate($deviceId, 'Kawan Jamming', '🎧');
    }

    $world = $roomManager->createRoom($name, false, null, $deviceId, 'world');

    Http::json(['success' => true, 'world' => $world]);
}

Http::error('Method not allowed', 405);
