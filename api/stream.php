<?php
// api/stream.php
// Pure PHP audio/track metadata resolver (No .exe, shared-hosting compatible)

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;
use Jamri\RateLimiter;
use Jamri\Validator;
use Jamri\YouTubeService;

Http::securityHeaders();

$pdo = Database::getConnection();
$ytService = new YouTubeService($pdo);
$rateLimiter = new RateLimiter();

$id = Validator::youtubeId($_GET['id'] ?? '');
if ($id === '') {
    Http::error('Invalid or missing YouTube ID', 400);
}

if (!$rateLimiter->allow(RateLimiter::key('stream', Http::clientKey()), 60, 60)) {
    Http::error('Terlalu banyak permintaan. Coba lagi sebentar.', 429);
}

try {
    $info = $ytService->getVideoInfo($id);
    Http::json([
        'success' => true,
        'stream' => [
            'youtube_id' => $id,
            'title' => $info['title'] ?? 'YouTube Audio',
            'channel' => $info['channel'] ?? 'Artist',
            'duration' => $info['duration'] ?? 0,
            'thumbnail' => Validator::thumbnailUrl($info['thumbnail'] ?? '')
                ?: "https://i.ytimg.com/vi/{$id}/mqdefault.jpg",
        ]
    ]);
} catch (\Throwable $e) {
    error_log('[stream.php] ' . $e->getMessage());
    Http::error('Gagal mengambil info lagu.', 502);
}
