<?php

declare(strict_types=1);

namespace Jamri;

use Psr\Http\Message\RequestInterface;
use Ratchet\ConnectionInterface;
use Ratchet\RFC6455\Messaging\FrameInterface;
use Ratchet\RFC6455\Messaging\MessageBuffer;
use Ratchet\RFC6455\Messaging\MessageInterface;
use Ratchet\WebSocket\WsServer;

class BoundedWsServer extends WsServer
{
    public function __construct(\Ratchet\ComponentInterface $component, private int $maxMessageBytes)
    {
        parent::__construct($component);
    }

    public function onOpen(ConnectionInterface $conn, ?RequestInterface $request = null)
    {
        $result = parent::onOpen($conn, $request);
        $max = $this->maxMessageBytes;
        \Closure::bind(function (ConnectionInterface $conn) use ($max): void {
            if (!$this->connections->contains($conn)) {
                return;
            }
            $context = $this->connections[$conn];
            $wsConn = $context->connection;
            $context->buffer = new MessageBuffer(
                $this->closeFrameChecker,
                function (MessageInterface $msg) use ($wsConn): void {
                    ($this->msgCb)($wsConn, $msg);
                },
                function (FrameInterface $frame) use ($wsConn): void {
                    $this->onControlFrame($frame, $wsConn);
                },
                true,
                $this->ueFlowFactory,
                $max,
                $max
            );
        }, $this, WsServer::class)($conn);
        return $result;
    }
}
