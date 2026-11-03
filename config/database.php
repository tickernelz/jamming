<?php
// config/database.php

declare(strict_types=1);

namespace Jamri;

use PDO;
use PDOException;

class Database
{
    private const SCHEMA_VERSION = 2;

    private static ?PDO $instance = null;

    public static function getConnection(): PDO
    {
        if (self::$instance === null) {
            $dbDir = self::dataDir();
            $dbPath = $dbDir . DIRECTORY_SEPARATOR . 'jamri.sqlite';
            if (!is_dir($dbDir)) {
                mkdir($dbDir, 0755, true);
            }

            try {
                self::$instance = self::open('sqlite:' . $dbPath);
            } catch (PDOException $e) {
                error_log('[Database] Connection failed: ' . $e->getMessage());
                http_response_code(500);
                echo json_encode(['success' => false, 'error' => 'Database tidak tersedia saat ini.']);
                exit;
            }
        }

        return self::$instance;
    }

    public static function dataDir(): string
    {
        return getenv('JAMRI_DATA_DIR') ?: dirname(__DIR__) . DIRECTORY_SEPARATOR . 'data';
    }

    public static function open(string $dsn): PDO
    {
        $pdo = new PDO($dsn);
        $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
        $pdo->exec('PRAGMA journal_mode = WAL;');
        $pdo->exec('PRAGMA foreign_keys = ON;');
        $pdo->exec('PRAGMA synchronous = NORMAL;');
        $pdo->exec('PRAGMA busy_timeout = 5000;');
        self::initSchema($pdo);
        return $pdo;
    }

    /** Bring the schema to SCHEMA_VERSION once; an up-to-date database costs one PRAGMA per connection. */
    private static function initSchema(PDO $pdo): void
    {
        if ((int)$pdo->query('PRAGMA user_version')->fetchColumn() >= self::SCHEMA_VERSION) {
            return;
        }
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            if ((int)$pdo->query('PRAGMA user_version')->fetchColumn() < self::SCHEMA_VERSION) {
                self::createSchema($pdo);
                self::migrate($pdo);
                self::migrateData($pdo);
                $pdo->exec('PRAGMA user_version = ' . self::SCHEMA_VERSION);
            }
            $pdo->exec('COMMIT');
        } catch (\Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    private static function createSchema(PDO $pdo): void
    {
        $sql = "
        CREATE TABLE IF NOT EXISTS users (
            device_id TEXT PRIMARY KEY,
            nickname TEXT NOT NULL,
            emoji TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_active DATETIME DEFAULT CURRENT_TIMESTAMP,
            session_hash TEXT NULL
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

        ";

        $pdo->exec($sql);
    }

    /**
     * Additive migrations for existing databases. Safe to run repeatedly:
     * every statement is guarded so older installs upgrade transparently.
     */
    private static function migrate(PDO $pdo): void
    {
        $addColumnTo = static function (string $table, string $name, string $definition) use ($pdo): void {
            foreach ($pdo->query("PRAGMA table_info({$table})")->fetchAll() as $row) {
                if ($row['name'] === $name) {
                    return;
                }
            }
            $pdo->exec("ALTER TABLE {$table} ADD COLUMN {$name} {$definition}");
        };
        $addColumn = static fn (string $name, string $definition) => $addColumnTo('rooms', $name, $definition);

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

        $addColumnTo('users', 'session_hash', 'TEXT NULL');
        $pdo->exec('DROP TABLE IF EXISTS room_soundboard');
        $pdo->exec("
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_session ON users(session_hash);
        CREATE TABLE IF NOT EXISTS room_access (
            room_id TEXT NOT NULL,
            device_id TEXT NOT NULL,
            granted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (room_id, device_id),
            FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
        );
        ");
    }

    private static function migrateData(PDO $pdo): void
    {
        $rows = $pdo->query('SELECT id, passcode FROM rooms WHERE passcode IS NOT NULL')->fetchAll();
        $hash = $pdo->prepare('UPDATE rooms SET passcode = :hash WHERE id = :id');
        foreach ($rows as $row) {
            if (password_get_info((string)$row['passcode'])['algo'] === null) {
                $hash->execute([':hash' => password_hash((string)$row['passcode'], PASSWORD_DEFAULT), ':id' => $row['id']]);
            }
        }

        foreach (['users' => 'emoji', 'chat_messages' => 'sender_emoji'] as $table => $column) {
            $scrub = $pdo->prepare("UPDATE {$table} SET {$column} = :clean WHERE {$column} = :dirty");
            foreach ($pdo->query("SELECT DISTINCT {$column} FROM {$table}")->fetchAll(PDO::FETCH_COLUMN) as $value) {
                $clean = Validator::emoji($value);
                if ($clean !== $value) {
                    $scrub->execute([':clean' => $clean, ':dirty' => $value]);
                }
            }
        }
    }
}
