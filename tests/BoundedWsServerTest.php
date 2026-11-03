<?php

declare(strict_types=1);

namespace Jamri\Tests;

use GuzzleHttp\Psr7\Request;
use Jamri\BoundedWsServer;
use PHPUnit\Framework\TestCase;
use Ratchet\ConnectionInterface;
use Ratchet\MessageComponentInterface;
use Ratchet\RFC6455\Messaging\Frame;

final class BoundedWsServerTest extends TestCase
{
    public function testMessagesAboveLimitCloseTheConnectionAndNeverReachHandler(): void
    {
        $handler = new class implements MessageComponentInterface {
            public array $received = [];
            public function onOpen(ConnectionInterface $conn) {}
            public function onClose(ConnectionInterface $conn) {}
            public function onError(ConnectionInterface $conn, \Exception $e) {}
            public function onMessage(ConnectionInterface $from, $msg)
            {
                $this->received[] = (string)$msg;
            }
        };
        $server = new BoundedWsServer($handler, 1024);
        $conn = new FakeConnection(new Request('GET', '/ws', [
            'Host' => 'jamming.test',
            'Upgrade' => 'websocket',
            'Connection' => 'Upgrade',
            'Sec-WebSocket-Key' => base64_encode(random_bytes(16)),
            'Sec-WebSocket-Version' => '13',
        ]));
        $server->onOpen($conn, $conn->httpRequest);

        $small = new Frame('ok', true, Frame::OP_TEXT);
        $small->maskPayload();
        $server->onMessage($conn, $small->getContents());
        self::assertSame(['ok'], $handler->received);
        self::assertFalse($conn->closed);

        $big = new Frame(str_repeat('a', 4096), true, Frame::OP_TEXT);
        $big->maskPayload();
        $server->onMessage($conn, $big->getContents());

        self::assertSame(['ok'], $handler->received);
        self::assertTrue($conn->closed);
    }
}
