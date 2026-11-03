<?php

declare(strict_types=1);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\Http;

Http::securityHeaders();
header('Cache-Control: no-store');

$db = false;
try {
    $db = (int)Database::getConnection()->query('SELECT 1')->fetchColumn() === 1;
} catch (\Throwable $e) {
    error_log('[health] database check failed: ' . $e->getMessage());
}

$config = require dirname(__DIR__) . '/config/app.php';
$socket = @fsockopen('127.0.0.1', (int)$config['ws_port'], $errno, $errstr, 1.0);
$ws = $socket !== false;
if ($ws) {
    fclose($socket);
}

Http::json(['ok' => $db && $ws, 'db' => $db, 'ws' => $ws], $db && $ws ? 200 : 503);
