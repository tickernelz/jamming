<?php

declare(strict_types=1);

namespace Jamri\Tests;

use Jamri\RoomManager;
use Jamri\UserManager;
use Jamri\WebSocketHandler;
use PHPUnit\Framework\TestCase;

final class WebSocketHandlerTest extends TestCase
{
    private RoomManager $rooms;
    private WebSocketHandler $ws;
    private array $host;
    private array $guest;
    private string $statePath;

    protected function setUp(): void
    {
        $pdo = TestDatabase::memory();
        $this->rooms = new RoomManager($pdo);
        $users = new UserManager($pdo);
        $this->host = $users->register('Host', '🎧');
        $this->guest = $users->register('Guest', '🎸');
        $this->statePath = sys_get_temp_dir() . '/jamri-runtime-' . bin2hex(random_bytes(4)) . '.json';
        $this->ws = new WebSocketHandler($this->rooms, $users, [], null, $this->statePath);
    }

    protected function tearDown(): void
    {
        @unlink($this->statePath);
    }

    private function room(bool $private = false, string $control = 'owner'): string
    {
        return $this->rooms->createRoom('Lobby', $private, $private ? 's3cretpass' : null, $this->host['user']['device_id'], 'legacy', null, null, $control)['id'];
    }

    private function join(string $roomId, array $session, array $query = [], string $ip = '203.0.113.7'): FakeConnection
    {
        $conn = FakeConnection::forRoom($roomId, $session['token'], $query, 'https://jamming.test', $ip);
        $this->ws->onOpen($conn);
        return $conn;
    }

    private function send(FakeConnection $conn, array $message): void
    {
        $this->ws->onMessage($conn, json_encode($message));
    }

    private function track(string $id = 'dQw4w9WgXcQ', int $duration = 200): array
    {
        return ['youtube_id' => $id, 'title' => 'Song ' . $id, 'channel' => 'Ch', 'duration_seconds' => $duration, 'thumbnail_url' => ''];
    }

    public function testConnectionWithoutSessionIsRejectedEvenWithHostDeviceId(): void
    {
        $conn = FakeConnection::forRoom($this->room(), null, ['device_id' => $this->host['user']['device_id']]);
        $this->ws->onOpen($conn);

        self::assertTrue($conn->closed);
        self::assertSame('auth_required', $conn->messages()[0]['code']);
    }

    public function testCrossOriginConnectionIsRejected(): void
    {
        $conn = FakeConnection::forRoom($this->room(), $this->host['token'], [], 'https://evil.example');
        $this->ws->onOpen($conn);

        self::assertTrue($conn->closed);
        self::assertSame('forbidden', $conn->messages()[0]['code']);
    }

    public function testPrivateRoomNeedsGrantNotPasscodeInUrl(): void
    {
        $roomId = $this->room(true);

        $denied = $this->join($roomId, $this->guest, ['passcode' => 's3cretpass']);
        self::assertTrue($denied->closed);
        self::assertSame([], $denied->messagesOfType('room_init'));

        $this->rooms->grantAccess($roomId, $this->guest['user']['device_id']);
        $allowed = $this->join($roomId, $this->guest);
        self::assertFalse($allowed->closed);
        self::assertCount(1, $allowed->messagesOfType('room_init'));
    }

    public function testIdentityComesFromSessionNotQuery(): void
    {
        $conn = $this->join($this->room(), $this->guest, [
            'device_id' => $this->host['user']['device_id'],
            'nickname' => 'Host',
            'emoji' => '<img src=x onerror="window.__xss=1">',
        ]);
        $init = $conn->messagesOfType('room_init')[0];

        self::assertFalse($init['is_host']);
        self::assertSame($this->guest['user'], $init['you']);
        self::assertStringNotContainsString('<img', implode('', $conn->raw));
    }

    public function testGuestCannotControlUntilHostEnablesSharedControl(): void
    {
        $roomId = $this->room();
        $host = $this->join($roomId, $this->host);
        $guest = $this->join($roomId, $this->guest);
        $this->send($host, ['type' => 'queue_add', 'track' => $this->track()]);
        $host->clear();
        $guest->clear();

        foreach (['pause', 'next', 'set_loop', 'queue_shuffle', 'game_start', 'set_room_control'] as $type) {
            $this->send($guest, ['type' => $type, 'mode' => 'all', 'control_mode' => 'everyone']);
        }
        $this->send($guest, ['type' => 'set_track', 'track' => $this->track('aaaaaaaaaaa')]);

        self::assertSame([], $host->messages());
        self::assertCount(7, $guest->messagesOfType('notice'));
        self::assertSame('owner', $this->rooms->getRoomSummary($roomId)['box_control']);

        $this->send($host, ['type' => 'set_room_control', 'control_mode' => 'everyone']);
        self::assertSame('everyone', $guest->messagesOfType('control_mode_changed')[0]['control_mode']);
        self::assertSame('everyone', $this->rooms->getRoomSummary($roomId)['box_control']);

        $this->send($guest, ['type' => 'pause']);
        self::assertSame('Guest', $host->messagesOfType('pause')[0]['triggered_by']);
    }

    public function testHostControlsPlayback(): void
    {
        $roomId = $this->room();
        $host = $this->join($roomId, $this->host);
        $guest = $this->join($roomId, $this->guest);
        $this->send($host, ['type' => 'set_track', 'track' => $this->track()]);
        $this->send($host, ['type' => 'pause']);

        self::assertSame('dQw4w9WgXcQ', $guest->messagesOfType('track_change')[0]['track']['youtube_id']);
        self::assertCount(1, $guest->messagesOfType('pause'));
        self::assertTrue($host->messagesOfType('room_init')[0]['is_host']);
    }

    public function testGuestCannotSkipByReportingTrackEndedMidSong(): void
    {
        $roomId = $this->room();
        $host = $this->join($roomId, $this->host);
        $guest = $this->join($roomId, $this->guest);
        $this->send($host, ['type' => 'queue_add', 'track' => $this->track('aaaaaaaaaaa')]);
        $this->send($host, ['type' => 'queue_add', 'track' => $this->track('bbbbbbbbbbb')]);
        $host->clear();

        $this->send($guest, ['type' => 'track_ended']);

        self::assertSame([], $host->messagesOfType('track_change'));
    }

    public function testOnlyHostClearsPunishment(): void
    {
        $roomId = $this->room();
        $host = $this->join($roomId, $this->host);
        $guest = $this->join($roomId, $this->guest);
        $host->clear();

        $this->send($guest, ['type' => 'punishment_clear', 'device_id' => $this->guest['user']['device_id']]);

        self::assertSame([], $host->messages());
        self::assertCount(1, $guest->messagesOfType('notice'));
    }

    public function testConnectionsPerIpAreCapped(): void
    {
        $roomId = $this->room();
        for ($i = 0; $i < WebSocketHandler::MAX_CONNECTIONS_PER_IP; $i++) {
            self::assertFalse($this->join($roomId, $this->guest, [], '198.51.100.9')->closed);
        }

        $extra = $this->join($roomId, $this->guest, [], '198.51.100.9');
        self::assertTrue($extra->closed);
        self::assertSame('rate_limited', $extra->messages()[0]['code']);
        self::assertFalse($this->join($roomId, $this->host, [], '198.51.100.10')->closed);
    }

    public function testWorldIdentityComesFromSession(): void
    {
        $worldId = $this->rooms->createRoom('World', false, null, $this->host['user']['device_id'], 'world')['id'];
        $conn = FakeConnection::forRoom($worldId, $this->guest['token'], ['mode' => 'world', 'nickname' => 'Host', 'device_id' => $this->host['user']['device_id']]);
        $this->ws->onOpen($conn);
        $init = $conn->messagesOfType('world_init')[0];

        self::assertSame('Guest', $init['you']['nickname']);
        self::assertFalse($init['you']['is_owner']);
    }
}
