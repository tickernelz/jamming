<?php
// api/playlist.php
// Resolve a public YouTube playlist into a list of tracks (for Bank Musik import).

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

$raw = $_GET['url'] ?? $_GET['list'] ?? $_GET['playlist'] ?? '';
$playlistId = Validator::playlistId($raw);
$limit = Validator::playlistLimit($_GET['limit'] ?? 50);

if ($playlistId === '') {
    Http::error('Link atau ID playlist YouTube tidak valid.', 400);
}

// Playlist resolution hits YouTube: throttle per client.
if (!$rateLimiter->allow(RateLimiter::key('playlist', Http::clientKey()), 10, 60)) {
    Http::error('Terlalu banyak permintaan playlist. Coba lagi sebentar.', 429);
}

try {
    $tracks = $ytService->getPlaylistItems($playlistId, $limit);
} catch (\Throwable $e) {
    error_log('[playlist.php] ' . $e->getMessage());
    Http::error('Gagal mengambil playlist. Coba lagi.', 502);
}

if (empty($tracks)) {
    Http::json([
        'success' => false,
        'error' => 'playlist_empty',
        'message' => 'Playlist kosong, privat, atau tidak dapat diakses.',
        'playlist_id' => $playlistId,
        'tracks' => [],
    ]);
}

Http::json([
    'success' => true,
    'playlist_id' => $playlistId,
    'count' => count($tracks),
    'tracks' => $tracks,
]);
