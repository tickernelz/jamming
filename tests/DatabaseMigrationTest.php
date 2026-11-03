<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\Database;
use Jamri\Validator;
use PDO;
use PHPUnit\Framework\TestCase;

final class DatabaseMigrationTest extends TestCase
{
    public function testLegacyDatabaseIsHashedScrubbedAndExtended(): void
    {
        $path = tempnam(sys_get_temp_dir(), 'jamri-legacy-');
        $legacy = new PDO('sqlite:' . $path);
        $legacy->exec("
            CREATE TABLE users (device_id TEXT PRIMARY KEY, nickname TEXT NOT NULL, emoji TEXT NOT NULL,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP, last_active DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, is_private INTEGER DEFAULT 0,
                passcode TEXT NULL, host_device_id TEXT NOT NULL, current_track_id TEXT NULL, playback_position REAL DEFAULT 0,
                playback_state TEXT DEFAULT 'stopped', last_state_change DATETIME DEFAULT CURRENT_TIMESTAMP,
                empty_since DATETIME NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, sender_nickname TEXT NOT NULL,
                sender_emoji TEXT NOT NULL, message TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE room_soundboard (id INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL);
            INSERT INTO users (device_id, nickname, emoji) VALUES ('dev_old', 'Old', '<img src=x onerror=alert(1)>');
            INSERT INTO rooms (id, name, slug, is_private, passcode, host_device_id) VALUES ('r1', 'Secret', 'secret', 1, 's3cretpass', 'dev_old');
            INSERT INTO chat_messages (room_id, sender_nickname, sender_emoji, message) VALUES ('r1', 'Old', '<svg onload=alert(1)>', 'hi');
        ");
        unset($legacy);

        $pdo = Database::open('sqlite:' . $path);

        $passcode = $pdo->query("SELECT passcode FROM rooms WHERE id = 'r1'")->fetchColumn();
        self::assertTrue(password_verify('s3cretpass', $passcode));
        self::assertSame(Validator::DEFAULT_EMOJI, $pdo->query('SELECT emoji FROM users')->fetchColumn());
        self::assertSame(Validator::DEFAULT_EMOJI, $pdo->query('SELECT sender_emoji FROM chat_messages')->fetchColumn());
        self::assertNull($pdo->query('SELECT session_hash FROM users')->fetchColumn());
        self::assertSame('everyone', $pdo->query("SELECT box_control FROM rooms WHERE id = 'r1'")->fetchColumn());
        self::assertFalse($pdo->query("SELECT 1 FROM sqlite_master WHERE name = 'room_soundboard'")->fetchColumn());
        self::assertSame(1, (int)$pdo->query("SELECT COUNT(*) FROM sqlite_master WHERE name = 'room_access'")->fetchColumn());

        self::assertSame(2, (int)$pdo->query('PRAGMA user_version')->fetchColumn());

        $pdo->exec("INSERT INTO rooms (id, name, slug, is_private, passcode, host_device_id) VALUES ('r2', 'Late', 'late', 1, 'plain', 'dev_old')");
        unset($pdo);
        $again = Database::open('sqlite:' . $path);
        self::assertSame($passcode, $again->query("SELECT passcode FROM rooms WHERE id = 'r1'")->fetchColumn());
        self::assertSame('plain', $again->query("SELECT passcode FROM rooms WHERE id = 'r2'")->fetchColumn(), 'an up-to-date database must not rerun migrations');
        unset($again);
        @unlink($path);
    }
}
