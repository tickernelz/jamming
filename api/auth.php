<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\UserManager;

Http::securityHeaders();

$pdo = Database::getConnection();
$userManager = new UserManager($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $user = Http::currentUser($userManager);
    Http::json(['exists' => $user !== null, 'user' => $user]);
}

if ($method !== 'POST') {
    Http::error('Method not allowed', 405);
}

$input = Http::input();
$nickname = (string)($input['nickname'] ?? '');
$emoji = (string)($input['emoji'] ?? '');
$rateLimiter = new RateLimiter();
$current = Http::currentUser($userManager);

if ($current !== null) {
    if (!$rateLimiter->allow(RateLimiter::key('auth_write', $current['device_id']), 10, 60)) {
        Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
    }
    Http::json(['success' => true, 'user' => $userManager->updateProfile($current['device_id'], $nickname, $emoji)]);
}

if (!$rateLimiter->allow(RateLimiter::key('auth_register', Http::clientKey()), 20, 3600)) {
    Http::error('Terlalu banyak profil dibuat dari alamat ini. Coba lagi nanti.', 429);
}

$session = $userManager->register($nickname, $emoji);
Http::startSession($session['token']);
Http::json(['success' => true, 'user' => $session['user']]);
