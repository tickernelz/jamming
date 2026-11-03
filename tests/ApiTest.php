<?php

declare(strict_types=1);

namespace Jamri\Tests;

use PHPUnit\Framework\TestCase;

final class ApiTest extends TestCase
{
    private static $server;
    private static string $base;
    private static string $dataDir;

    public static function setUpBeforeClass(): void
    {
        self::$dataDir = sys_get_temp_dir() . '/jamri-api-' . bin2hex(random_bytes(4));
        mkdir(self::$dataDir);
        $port = random_int(20000, 40000);
        self::$base = "http://127.0.0.1:{$port}";
        self::$server = proc_open(
            [PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', dirname(__DIR__), dirname(__DIR__) . '/bin/dev-router.php'],
            [['pipe', 'r'], ['file', '/dev/null', 'w'], ['file', '/dev/null', 'w']],
            $pipes,
            null,
            ['JAMRI_DATA_DIR' => self::$dataDir]
        );
        for ($i = 0; $i < 50; $i++) {
            if (@fsockopen('127.0.0.1', $port) !== false) {
                return;
            }
            usleep(100000);
        }
        self::fail('php -S did not start');
    }

    public static function tearDownAfterClass(): void
    {
        proc_terminate(self::$server);
        proc_close(self::$server);
        array_map('unlink', glob(self::$dataDir . '/*') ?: []);
        @rmdir(self::$dataDir);
    }

    private function request(string $method, string $path, ?array $body = null, ?string $cookie = null, ?string $raw = null, array $extraHeaders = [], string $contentType = 'application/json'): array
    {
        $headers = array_merge(['Content-Type: ' . $contentType], $extraHeaders);
        if ($cookie !== null) {
            $headers[] = 'Cookie: jamri_session=' . $cookie;
        }
        $context = stream_context_create(['http' => [
            'method' => $method,
            'header' => implode("\r\n", $headers),
            'content' => $raw ?? ($body !== null ? json_encode($body) : ''),
            'ignore_errors' => true,
        ]]);
        $response = file_get_contents(self::$base . $path, false, $context);
        $headers = function_exists('http_get_last_response_headers') ? http_get_last_response_headers() : $http_response_header;
        $status = (int)explode(' ', $headers[0])[1];
        return ['status' => $status, 'body' => json_decode((string)$response, true), 'headers' => $headers];
    }

    private function register(string $nickname): array
    {
        $res = $this->request('POST', '/api/auth.php', ['nickname' => $nickname, 'emoji' => '🎸']);
        $cookieHeader = current(array_filter($res['headers'], static fn (string $h): bool => stripos($h, 'Set-Cookie: jamri_session=') === 0));
        self::assertNotFalse($cookieHeader);
        preg_match('/jamri_session=([a-f0-9]{64})/', $cookieHeader, $m);
        return ['token' => $m[1], 'user' => $res['body']['user'], 'cookie_header' => $cookieHeader];
    }

    public function testPrivateRoomFlowEnforcesSessionPasscodeAndHost(): void
    {
        $host = $this->register('Host');
        self::assertStringContainsStringIgnoringCase('HttpOnly', $host['cookie_header']);
        self::assertStringContainsStringIgnoringCase('SameSite=Strict', $host['cookie_header']);
        self::assertSame('Host', $this->request('GET', '/api/auth.php', null, $host['token'])['body']['user']['nickname']);
        self::assertFalse($this->request('GET', '/api/auth.php?device_id=' . $host['user']['device_id'])['body']['exists']);

        $legacy = $this->request('POST', '/api/rooms.php', ['name' => 'Old', 'device_id' => $host['user']['device_id']]);
        self::assertSame(401, $legacy['status']);

        $created = $this->request('POST', '/api/rooms.php', ['name' => 'Secret', 'is_private' => 1, 'passcode' => 's3cretpass'], $host['token']);
        self::assertSame(200, $created['status']);
        $roomId = $created['body']['room']['id'];
        self::assertArrayNotHasKey('passcode', $created['body']['room']);
        self::assertArrayNotHasKey('host_device_id', $created['body']['room']);

        $list = $this->request('GET', '/api/rooms.php')['body']['rooms'];
        self::assertStringNotContainsString($host['user']['device_id'], json_encode($list));
        self::assertStringNotContainsString('passcode', json_encode($list));

        $guest = $this->register('Guest');
        $track = ['youtube_id' => 'dQw4w9WgXcQ', 'title' => 'x'];
        self::assertSame(403, $this->request('GET', '/api/chat.php?room_id=' . $roomId, null, $guest['token'])['status']);
        self::assertSame(401, $this->request('GET', '/api/chat.php?room_id=' . $roomId)['status']);
        self::assertSame(403, $this->request('GET', '/api/room_detail.php?room_id=' . $roomId . '&passcode=s3cretpass', null, $guest['token'])['status']);
        self::assertSame(403, $this->request('POST', '/api/room_detail.php?room_id=' . $roomId, ['passcode' => 'wrong'], $guest['token'])['status']);
        self::assertSame(403, $this->request('POST', '/api/rooms.php', ['action' => 'add_playlist', 'room_id' => $roomId, 'track' => $track], $guest['token'])['status']);

        $joined = $this->request('POST', '/api/room_detail.php?room_id=' . $roomId, ['passcode' => 's3cretpass'], $guest['token']);
        self::assertSame(200, $joined['status']);
        self::assertFalse($joined['body']['data']['room']['is_host']);
        self::assertArrayNotHasKey('host_device_id', $joined['body']['data']['room']);
        self::assertSame(200, $this->request('GET', '/api/chat.php?room_id=' . $roomId, null, $guest['token'])['status']);
        self::assertSame(200, $this->request('GET', '/api/room_detail.php?room_id=' . $roomId, null, $guest['token'])['status']);

        $guestPlaylist = $this->request('POST', '/api/rooms.php', ['action' => 'add_playlist', 'room_id' => $roomId, 'track' => $track], $guest['token']);
        self::assertSame('host_only', $guestPlaylist['body']['error']);
        self::assertTrue($this->request('POST', '/api/rooms.php', ['action' => 'add_playlist', 'room_id' => $roomId, 'track' => $track], $host['token'])['body']['success']);
    }

    public function testPasscodeGuessingIsThrottled(): void
    {
        $host = $this->register('Host2');
        $roomId = $this->request('POST', '/api/rooms.php', ['name' => 'Vault', 'is_private' => 1, 'passcode' => 'correct-horse'], $host['token'])['body']['room']['id'];
        $attacker = $this->register('Attacker');

        $statuses = [];
        for ($i = 0; $i < 9; $i++) {
            $statuses[] = $this->request('POST', '/api/room_detail.php?room_id=' . $roomId, ['passcode' => 'guess' . $i], $attacker['token'])['status'];
        }
        self::assertSame(array_fill(0, 8, 403), array_slice($statuses, 0, 8));
        self::assertSame(429, $statuses[8]);
        self::assertSame(429, $this->request('POST', '/api/room_detail.php?room_id=' . $roomId, ['passcode' => 'correct-horse'], $attacker['token'])['status']);
    }

    public function testCrossSitePostCannotReplaceTheSession(): void
    {
        $evil = ['Origin: https://evil.example'];
        $attempts = [
            $this->request('POST', '/api/auth.php', null, null, 'nickname=pwned&emoji=x', $evil, 'application/x-www-form-urlencoded'),
            $this->request('POST', '/api/auth.php', null, null, '{"nickname":"pwned"}', $evil, 'text/plain'),
            $this->request('POST', '/api/auth.php', ['nickname' => 'pwned'], null, null, $evil),
            $this->request('POST', '/api/auth.php', ['nickname' => 'pwned'], null, null, ['Sec-Fetch-Site: cross-site']),
            $this->request('POST', '/api/auth.php', ['nickname' => 'pwned'], null, null, ['Origin: null']),
        ];

        foreach ($attempts as $i => $res) {
            self::assertSame(403, $res['status'], "attempt {$i}");
            self::assertSame([], preg_grep('/^Set-Cookie:/i', $res['headers']), "attempt {$i}");
        }

        $form = $this->request('POST', '/api/auth.php', null, null, 'nickname=x', [], 'application/x-www-form-urlencoded');
        self::assertSame(415, $form['status']);

        $sameOrigin = $this->request('POST', '/api/auth.php', ['nickname' => 'Real'], null, null, [
            'Origin: ' . self::$base,
            'Sec-Fetch-Site: same-origin',
        ]);
        self::assertSame(200, $sameOrigin['status']);
        self::assertNotSame([], preg_grep('/^Set-Cookie: jamri_session=/i', $sameOrigin['headers']));
    }

    public function testCspAllowsOnlyThisOriginsWebSocket(): void
    {
        $csp = current(preg_grep('/^Content-Security-Policy:/i', $this->request('GET', '/')['headers']));
        preg_match("/connect-src ([^;]+);/", $csp, $m);
        $sources = explode(' ', trim($m[1]));

        self::assertNotContains('ws:', $sources);
        self::assertNotContains('wss:', $sources);
        self::assertContains('ws://127.0.0.1:8081', $sources);
    }

    public function testShellLinksEveryAssetByVersionedPathWithoutQueryString(): void
    {
        $html = (string)file_get_contents(self::$base . '/');
        preg_match_all('#(?:src|href)="(?!https?:)([^"?]+\.(?:js|css)(?:\?[^"]*)?)"#', $html, $m);

        self::assertNotEmpty($m[1]);
        foreach ($m[1] as $url) {
            self::assertStringNotContainsString('?', $url);
            self::assertMatchesRegularExpression('#^v/[0-9a-f]+/public/(js|css)/[A-Za-z0-9_.-]+\.(js|css)$#', $url);
            $res = $this->request('GET', '/' . $url);
            self::assertSame(200, $res['status'], $url);
            self::assertSame(
                filesize(dirname(__DIR__) . '/' . preg_replace('#^v/[0-9a-f]+/#', '', $url)),
                (int)current(preg_replace('/^content-length:\s*/i', '', preg_grep('/^content-length:/i', $res['headers']))),
                $url
            );
        }
        foreach (['/v/1/public/../composer.json', '/v/1/public/%2e%2e/composer.json', '/v/1/public/../config/database.php', '/v/1/config/database.php'] as $path) {
            $raw = (string)@file_get_contents(self::$base . $path, false, stream_context_create(['http' => ['ignore_errors' => true]]));
            self::assertStringNotContainsString('cboden/ratchet', $raw, $path);
            self::assertStringNotContainsString('<?php', $raw, $path);
        }
    }

    public function testOversizedBodyIsRejected(): void
    {
        $res = $this->request('POST', '/api/auth.php', null, null, json_encode(['nickname' => str_repeat('a', 20000)]));
        self::assertSame(413, $res['status']);
    }

    public function testEmojiMarkupIsNeverStored(): void
    {
        $res = $this->request('POST', '/api/auth.php', ['nickname' => 'X', 'emoji' => '<img src=x onerror=alert(1)>']);
        self::assertSame('🎧', $res['body']['user']['emoji']);
    }
}
