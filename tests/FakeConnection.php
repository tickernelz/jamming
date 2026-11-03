<?php

declare(strict_types=1);

namespace Jamri\Tests;

use GuzzleHttp\Psr7\Request;
use Psr\Http\Message\RequestInterface;
use Ratchet\ConnectionInterface;

final class FakeConnection implements ConnectionInterface
{
    private static int $nextId = 1;

    public int $resourceId;
    public string $remoteAddress = '127.0.0.1';
    public RequestInterface $httpRequest;
    public array $raw = [];
    public bool $closed = false;
    public ?\stdClass $WebSocket = null;

    public function __construct(RequestInterface $request)
    {
        $this->resourceId = self::$nextId++;
        $this->httpRequest = $request;
    }

    public static function forRoom(string $roomId, ?string $token, array $query = [], string $origin = 'https://jamming.test', string $ip = '203.0.113.7'): self
    {
        $headers = ['Host' => 'jamming.test', 'Origin' => $origin, 'X-Real-IP' => $ip];
        if ($token !== null) {
            $headers['Cookie'] = 'theme=dark; jamri_session=' . $token;
        }
        $uri = '/ws?' . http_build_query(['room_id' => $roomId] + $query);
        return new self(new Request('GET', $uri, $headers));
    }

    public function send($data)
    {
        $this->raw[] = $data;
        return $this;
    }

    public function close()
    {
        $this->closed = true;
    }

    public function messages(): array
    {
        return array_values(array_filter(array_map(static fn ($m) => json_decode((string)$m, true), $this->raw)));
    }

    public function messagesOfType(string $type): array
    {
        return array_values(array_filter($this->messages(), static fn (array $m): bool => ($m['type'] ?? null) === $type));
    }

    public function clear(): void
    {
        $this->raw = [];
    }
}
