<?php
// config/app.php
// Runtime application configuration.

declare(strict_types=1);

return [
    // WebSocket daemon port. Override with the JAMRI_WS_PORT environment
    // variable. Default 8081 because 8080 is commonly taken by Docker Desktop
    // on Windows (which silently owns the port even with WSL idle).
    'ws_port' => (int)(getenv('JAMRI_WS_PORT') ?: 8081),
];
