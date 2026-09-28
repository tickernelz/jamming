<?php
// config/database.php

declare(strict_types=1);

namespace Jamri;

use PDO;
use PDOException;

class Database
{
    private static ?PDO $instance = null;

    public static function getConnection(): PDO
    {
        if (self::$instance === null) {
            $dbDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
            if (!is_dir($dbDir)) {
                mkdir($dbDir, 0755, true);
            }
            $dbPath = $dbDir . DIRECTORY_SEPARATOR . 'jamri.sqlite';

            try {
                $pdo = new PDO('sqlite:' . $dbPath);
                $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
                $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);

                // Enable Write-Ahead Logging for better concurrent read/write and foreign keys
                $pdo->exec('PRAGMA journal_mode = WAL;');
                $pdo->exec('PRAGMA foreign_keys = ON;');
                $pdo->exec('PRAGMA synchronous = NORMAL;');
                $pdo->exec('PRAGMA busy_timeout = 5000;');

                self::$instance = $pdo;
                self::initSchema($pdo);
            } catch (PDOException $e) {
                // Log the detail, but never expose internals (paths, driver info)
                // to the client.
                error_log('[Database] Connection failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['success' => false, 'error' => 'Database tidak tersedia saat ini.']);
                exit;
            }
        }

        return self::$instance;
    }

    private static function initSchema(PDO $pdo): void
    {
        $sql = "
        CREATE TABLE IF NOT EXISTS users (
            device_id TEXT PRIMARY KEY,
            nickname TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_active DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS rooms (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            is_private INTEGER DEFAULT 0,
            passcode TEXT NULL,
            host_device_id TEXT NOT NULL,
            current_track_id TEXT NULL,
            playback_position REAL DEFAULT 0,
            playback_state TEXT DEFAULT 'stopped',
            last_state_change DATETIME DEFAULT CURRENT_TIMESTAMP,
            empty_since DATETIME NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_rooms_empty ON rooms(empty_since);
        CREATE INDEX IF NOT EXISTS idx_rooms_private ON rooms(is_private);

        CREATE TABLE IF NOT EXISTS room_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            youtube_id TEXT NOT NULL,
            title TEXT NOT NULL,
            channel TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL,
            thumbnail_url TEXT NULL,
            added_by_nickname TEXT NOT NULL,
            queue_order INTEGER NOT NULL,
            is_played INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_queue_room ON room_queue(room_id, queue_order);

        CREATE TABLE IF NOT EXISTS room_playlist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            youtube_id TEXT NOT NULL,
            title TEXT NOT NULL,
            channel TEXT NOT NULL,
            duration_seconds INTEGER NOT NULL,
            thumbnail_url TEXT NULL,
            added_by_nickname TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            sender_nickname TEXT NOT NULL,
            sender_emoji TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_chat_room ON chat_messages(room_id, id DESC);

        CREATE TABLE IF NOT EXISTS stream_cache (
            youtube_id TEXT PRIMARY KEY,
            stream_url TEXT NOT NULL,
            title TEXT NULL,
            channel TEXT NULL,
            duration_seconds INTEGER DEFAULT 0,
            thumbnail_url TEXT NULL,
            expires_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS room_soundboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            room_id TEXT NOT NULL,
            title TEXT NOT NULL,
            emoji TEXT DEFAULT '🔊',
            file_url TEXT NOT NULL,
            duration_seconds REAL DEFAULT 0,
            added_by_nickname TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_soundboard_room ON room_soundboard(room_id, id);
        ";

        $pdo->exec($sql);

        self::migrate($pdo);
    }

    /**
     * Additive migrations for existing databases. Safe to run repeatedly:
     * every statement is guarded so older installs upgrade transparently.
     */
    private static function migrate(PDO $pdo): void
    {
        $columns = [];
        foreach ($pdo->query('PRAGMA table_info(rooms)')->fetchAll() as $row) {
            $columns[$row['name']] = true;
        }

        $addColumn = static function (string $name, string $definition) use ($pdo, &$columns): void {
            if (!isset($columns[$name])) {
                $pdo->exec("ALTER TABLE rooms ADD COLUMN {$name} {$definition}");
                $columns[$name] = true;
            }
        };

        // World mode support (additive; legacy rooms keep working unchanged).
        $addColumn('mode', "TEXT DEFAULT 'legacy'");
        $addColumn('parent_world_id', 'TEXT NULL');
        $addColumn('map_json', 'TEXT NULL');
        $addColumn('box_control', "TEXT DEFAULT 'everyone'");

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_rooms_mode ON rooms(mode, parent_world_id)');

        $pdo->exec("
        CREATE TABLE IF NOT EXISTS world_boxes (
            id TEXT PRIMARY KEY,
            world_id TEXT NOT NULL,
            room_id TEXT NOT NULL UNIQUE,
            owner_device_id TEXT NOT NULL,
            label TEXT NOT NULL,
            x REAL NOT NULL,
            y REAL NOT NULL,
            radius REAL NOT NULL DEFAULT 120,
            control_mode TEXT NOT NULL DEFAULT 'everyone',
            empty_since DATETIME NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (world_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_boxes_world ON world_boxes(world_id);
        ");
    }
}
