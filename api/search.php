<?php
// api/search.php

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\YouTubeService;

$pdo = Database::getConnection();
$ytService = new YouTubeService($pdo);

$q = trim((string)($_GET['q'] ?? ''));
$limit = min(20, max(1, (int)($_GET['limit'] ?? 12)));

if ($q === '') {
    echo json_encode(['success' => true, 'results' => []]);
    exit;
}

try {
    $results = $ytService->search($q, $limit);
    echo json_encode(['success' => true, 'results' => $results]);
} catch (\Throwable $e) {
    http_response_code(500);
    echo json_encode(['error' => 'Search failed: ' . $e->getMessage()]);
}
