<?php
// api/soundboard.php
// Soundboard files are stored client-side in browser IndexedDB (Discord-style real-time streaming)
// Zero server upload & zero storage attack surface.

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';

use Jamri\Http;

Http::securityHeaders();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    Http::json([
        'success' => true,
        'soundboards' => [],
        'message' => 'Soundboards are managed client-side in browser IndexedDB.'
    ]);
}

Http::json([
    'success' => false,
    'error' => 'Server file upload is disabled for security. Custom soundboards are stored locally in client IndexedDB.'
], 410);
