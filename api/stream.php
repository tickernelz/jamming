<?php
// api/stream.php
// Pure PHP audio/track metadata resolver (No .exe, shared-hosting compatible)

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\YouTubeService;

$pdo = Database::getConnection();
$ytService = new YouTubeService($pdo);

$id = trim((string)($_GET['id'] ?? ''));
if ($id === '' || !preg_match('/^[a-zA-Z0-9_-]{11}$/', $id)) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Invalid or missing YouTube ID']);
    exit;
}

try {
    $info = $ytService->getVideoInfo($id);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode([
        'success' => true,
        'stream' => [
            'youtube_id' => $id,
            'title' => $info['title'] ?? 'YouTube Audio',
            'channel' => $info['channel'] ?? 'Artist',
            'duration' => $info['duration'] ?? 0,
            'thumbnail' => $info['thumbnail'] ?? "https://i.ytimg.com/vi/{$id}/mqdefault.jpg",
        ]
    ]);
} catch (\Throwable $e) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Error: ' . $e->getMessage()]);
}
