<?php
// bin/websocket.php

declare(strict_types=1);

error_reporting(E_ALL & ~E_DEPRECATED);

require_once dirname(__DIR__) . '/vendor/autoload.php';
require_once dirname(__DIR__) . '/config/database.php';

use Jamri\Database;
use Jamri\RoomManager;
use Jamri\WebSocketHandler;
use Jamri\YouTubeService;
use Ratchet\Http\HttpServer;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Loop;
use React\Socket\SocketServer;

$port = 8081;
$appConfig = require dirname(__DIR__) . '/config/app.php';
if (is_array($appConfig) && isset($appConfig['ws_port'])) {
    $port = (int)$appConfig['ws_port'];
}
if (isset($argv[1]) && is_numeric($argv[1])) {
    $port = (int)$argv[1];
}

$pdo = Database::getConnection();
$roomManager = new RoomManager($pdo);
$ytService = new YouTubeService($pdo);
$wsHandler = new WebSocketHandler($roomManager, $ytService);

$loop = Loop::get();

// Periodic timer to purge rooms empty for >= 10 minutes (every 30 seconds)
$loop->addPeriodicTimer(30.0, function () use ($wsHandler) {
    $wsHandler->checkInactivity();
});

// Periodic timer to save runtime state snapshot for zero-downtime restarts (every 3 seconds)
$loop->addPeriodicTimer(3.0, function () use ($wsHandler) {
    $wsHandler->persistRuntimeState();
});

// World presence tick: one compact snapshot broadcast at 15 Hz.
$loop->addPeriodicTimer(1 / 15, function () use ($wsHandler) {
    $wsHandler->tickWorlds();
});

$socket = new SocketServer("0.0.0.0:{$port}", [], $loop);
$server = new IoServer(
    new HttpServer(
        new WsServer($wsHandler)
    ),
    $socket,
    $loop
);

echo "====================================================\n";
echo "   JAMRI REAL-TIME WEBSOCKET DAEMON\n";
echo "   Listening on: ws://0.0.0.0:{$port}\n";
echo "   Auto-destroy empty rooms: 10 minutes (600s)\n";
echo "   World presence tick: 15 Hz\n";
echo "   Status: RUNNING\n";
echo "====================================================\n";

$server->run();
