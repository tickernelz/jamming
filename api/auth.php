<?php
// api/auth.php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\UserManager;
use Jamri\Validator;

Http::securityHeaders();

$pdo = Database::getConnection();
$userManager = new UserManager($pdo);
$rateLimiter = new RateLimiter();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $deviceId = Validator::deviceId($_GET['device_id'] ?? '');
    if ($deviceId === '') {
        Http::error('device_id is required', 400);
    }

    $user = $userManager->getUser($deviceId);
    Http::json(['exists' => (bool)$user, 'user' => $user]);
}

if ($method === 'POST') {
    $input = Http::input();
    $deviceId = Validator::deviceId($input['device_id'] ?? '');
    $nickname = Validator::nickname($input['nickname'] ?? '', 'Kawan Jamming');
    $emoji = Validator::emoji($input['emoji'] ?? '');

    if ($deviceId === '') {
        Http::error('Device ID is required', 400);
    }

    // Anonymous platform: throttle profile writes per device to stop abuse.
    if (!$rateLimiter->allow(RateLimiter::key('auth_write', $deviceId), 10, 60)) {
        Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
    }

    $user = $userManager->registerOrUpdate($deviceId, $nickname, $emoji);
    Http::json(['success' => true, 'user' => $user]);
}

Http::error('Method not allowed', 405);
