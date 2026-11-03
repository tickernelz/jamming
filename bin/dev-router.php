<?php

declare(strict_types=1);

$path = (string)parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
if (preg_match('#^/v/[0-9]+/(public/[A-Za-z0-9_.\-/]+)$#', $path, $m) !== 1 || str_contains($m[1], '..')) {
    return false;
}

$file = dirname(__DIR__) . '/' . $m[1];
if (!is_file($file)) {
    http_response_code(404);
    return true;
}

$types = ['js' => 'text/javascript', 'css' => 'text/css', 'svg' => 'image/svg+xml', 'json' => 'application/json', 'png' => 'image/png'];
header('Content-Type: ' . ($types[pathinfo($file, PATHINFO_EXTENSION)] ?? 'application/octet-stream'));
header('Content-Length: ' . filesize($file));
header('Cache-Control: public, max-age=31536000, immutable');
readfile($file);
return true;
