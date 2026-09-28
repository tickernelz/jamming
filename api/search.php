<?php
// api/search.php

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

$q = Validator::clean($_GET['q'] ?? '', 120);
$limit = min(20, max(1, (int)($_GET['limit'] ?? 12)));

if ($q === '') {
    Http::json(['success' => true, 'results' => []]);
}

// Upstream YouTube calls are expensive: throttle per client.
if (!$rateLimiter->allow(RateLimiter::key('search', Http::clientKey()), 20, 60)) {
    Http::error('Terlalu banyak pencarian. Coba lagi sebentar.', 429);
}

try {
    $results = $ytService->search($q, $limit);
    Http::json(['success' => true, 'results' => $results]);
} catch (\Throwable $e) {
    // Never leak internal exception details to the client.
    error_log('[search.php] ' . $e->getMessage());
    Http::error('Pencarian gagal. Coba lagi.', 502);
}
