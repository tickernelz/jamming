<?php
// api/soundboard.php
// Soundboard files are stored client-side in browser IndexedDB (Discord-style real-time streaming)
// Zero server upload & zero storage attack surface.

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    echo json_encode([
        'success' => true,
        'soundboards' => [],
        'message' => 'Soundboards are managed client-side in browser IndexedDB.'
    ]);
    exit;
}

http_response_code(410);
echo json_encode([
    'success' => false,
    'error' => 'Server file upload is disabled for security. Custom soundboards are stored locally in client IndexedDB.'
]);
