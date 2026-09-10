<?php
// api/auth.php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\UserManager;

$pdo = Database::getConnection();
$userManager = new UserManager($pdo);
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $deviceId = trim((string)($_GET['device_id'] ?? ''));
    if ($deviceId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'device_id is required']);
        exit;
    }

    $user = $userManager->getUser($deviceId);
    echo json_encode(['exists' => (bool)$user, 'user' => $user]);
    exit;
}

if ($method === 'POST') {
    $input = json_decode(file_get_contents('php://input') ?: '', true) ?? $_POST;
    $deviceId = trim((string)($input['device_id'] ?? ''));
    $nickname = trim((string)($input['nickname'] ?? ''));
    $emoji = trim((string)($input['emoji'] ?? '🎧'));

    if ($deviceId === '') {
        http_response_code(400);
        echo json_encode(['error' => 'Device ID is required']);
        exit;
    }

    if ($nickname === '') {
        $nickname = 'Kawan Jamming';
    }

    $user = $userManager->registerOrUpdate($deviceId, $nickname, $emoji);
    echo json_encode(['success' => true, 'user' => $user]);
    exit;
}
