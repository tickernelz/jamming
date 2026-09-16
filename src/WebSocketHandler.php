<?php
// src/WebSocketHandler.php

declare(strict_types=1);

namespace Jamri;

use Exception;
use Ratchet\ConnectionInterface;
use Ratchet\MessageComponentInterface;
use SplObjectStorage;

class WebSocketHandler implements MessageComponentInterface
{
    private RoomManager $roomManager;
    private YouTubeService $ytService;

    /**
     * Structure:
     * [
     *   roomId => [
     *     'clients' => [resourceId => ConnectionInterface],
     *     'current_track' => array|null,
     *     'playback_state' => 'playing'|'paused'|'stopped',
     *     'position' => float,
     *     'last_sync_timestamp' => float,
     *     'empty_since' => int|null,
     *     'loop_mode' => 'off'|'one'|'all'
     *   ]
     * ]
     */
    private array $rooms = [];

    /**
     * Map resourceId => ['room_id', 'device_id', 'nickname', 'emoji']
     */
    private array $clientMeta = [];

    public function __construct(RoomManager $roomManager, YouTubeService $ytService)
    {
        $this->roomManager = $roomManager;
        $this->ytService = $ytService;
        $this->restoreRuntimeState();
        register_shutdown_function([$this, 'persistRuntimeState']);
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        // Parse query params from request
        $queryString = $conn->httpRequest->getUri()->getQuery();
        parse_str($queryString, $params);

        $roomId = trim((string)($params['room_id'] ?? ''));
        $deviceId = trim((string)($params['device_id'] ?? ''));
        $nickname = trim((string)($params['nickname'] ?? 'Guest'));
        $emoji = trim((string)($params['emoji'] ?? '🎧'));

        if ($roomId === '' || $deviceId === '') {
            $conn->send(json_encode(['type' => 'error', 'message' => 'room_id and device_id are required']));
            $conn->close();
            return;
        }

        $resId = $conn->resourceId;
        $this->clientMeta[$resId] = [
            'room_id' => $roomId,
            'device_id' => $deviceId,
            'nickname' => $nickname,
            'emoji' => $emoji,
        ];

        if (!isset($this->rooms[$roomId])) {
            // Load state from DB
            $roomSummary = $this->roomManager->getRoomSummary($roomId);
            $queue = $this->roomManager->getQueue($roomId);
            $initialTrack = null;
            if (!empty($roomSummary['current_track_id'])) {
                foreach ($queue as $qItem) {
                    if ($qItem['youtube_id'] === $roomSummary['current_track_id']) {
                        $initialTrack = $qItem;
                        break;
                    }
                }
            }
            if ($initialTrack === null && !empty($queue)) {
                $initialTrack = $queue[0];
            }

            $this->rooms[$roomId] = [
                'clients' => [],
                'current_track' => $initialTrack,
                'playback_state' => $initialTrack ? ($roomSummary['playback_state'] ?? 'paused') : 'stopped',
                'position' => (float)($roomSummary['playback_position'] ?? 0.0),
                'last_sync_timestamp' => microtime(true),
                'last_track_transition' => microtime(true),
                'empty_since' => null,
                'loop_mode' => 'off',
                'history' => [],
                'is_shuffled' => false,
                'punishments' => [],
            ];
        }

        $this->rooms[$roomId]['clients'][$resId] = $conn;
        $this->rooms[$roomId]['empty_since'] = null;
        $this->roomManager->markEmptySince($roomId, false);

        // Send current room state to joining client
        $currentPos = $this->getCurrentPosition($roomId);
        $queue = $this->roomManager->getQueue($roomId);

        $conn->send(json_encode([
            'type' => 'room_init',
            'room_id' => $roomId,
            'state' => $this->rooms[$roomId]['playback_state'],
            'position' => $currentPos,
            'current_track' => $this->rooms[$roomId]['current_track'],
            'loop_mode' => $this->rooms[$roomId]['loop_mode'] ?? 'off',
            'is_shuffled' => !empty($this->rooms[$roomId]['is_shuffled']),
            'queue' => $queue,
            'server_time' => (int)(microtime(true) * 1000),
            'online_users' => $this->getOnlineUsers($roomId),
            'punishments' => $this->getActivePunishments($roomId),
        ]));

        // Broadcast to others that a user joined
        $this->broadcastToRoom($roomId, [
            'type' => 'user_joined',
            'user' => [
                'nickname' => $nickname,
                'emoji' => $emoji,
                'device_id' => $deviceId,
            ],
            'online_users' => $this->getOnlineUsers($roomId),
            'punishments' => $this->getActivePunishments($roomId),
        ], $conn);
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $resId = $from->resourceId;
        if (!isset($this->clientMeta[$resId])) {
            return;
        }

        $meta = $this->clientMeta[$resId];
        $roomId = $meta['room_id'];
        $data = json_decode((string)$msg, true);

        if (!$data || empty($data['type'])) {
            return;
        }

        $type = $data['type'];

        // Guard: Check if music control action is attempted by a currently punished user
        $musicControlActions = [
            'play', 'pause', 'seek', 'set_track', 'next', 'prev',
            'set_loop', 'queue_add', 'queue_reorder', 'queue_remove',
            'queue_shuffle', 'playlist_add', 'playlist_remove'
        ];

        if (in_array($type, $musicControlActions, true)) {
            if ($this->isUserPunished($roomId, $meta['device_id'], $meta['nickname'])) {
                $p = $this->getUserPunishment($roomId, $meta['device_id'], $meta['nickname']);
                $remainSec = max(1, ($p['until'] ?? time()) - time());
                $remStr = sprintf('%02d:%02d', floor($remainSec / 60), $remainSec % 60);
                $gameName = $p['game_name'] ?? 'Mini Game';

                $from->send(json_encode([
                    'type' => 'notice',
                    'message' => "🚫 Kamu sedang dihukum kalah di {$gameName}! Tidak bisa mengatur musik (sisa {$remStr}).",
                    'level' => 'warning',
                ]));
                $from->send(json_encode([
                    'type' => 'punishment_status',
                    'punished' => true,
                    'punishment' => $p,
                ]));
                return;
            }
        }

        switch ($type) {
            case 'ping':
                $from->send(json_encode([
                    'type' => 'pong',
                    'server_time' => (int)(microtime(true) * 1000),
                    'position' => $this->getCurrentPosition($roomId),
                    'state' => $this->rooms[$roomId]['playback_state'] ?? 'stopped',
                    'track' => $this->rooms[$roomId]['current_track'] ?? null,
                ]));
                break;

            case 'play':
                if (empty($this->rooms[$roomId]['current_track'])) {
                    // If no track is currently set, automatically start the first song from queue!
                    $this->playNextInQueue($roomId, $meta['nickname']);
                    break;
                }

                $requestedPos = isset($data['position']) ? (float)$data['position'] : $this->getCurrentPosition($roomId);
                $this->rooms[$roomId]['playback_state'] = 'playing';
                $this->rooms[$roomId]['position'] = $requestedPos;
                $this->rooms[$roomId]['last_sync_timestamp'] = microtime(true);

                // Broadcast immediately to all clients with 0ms network latency
                $this->broadcastToRoom($roomId, [
                    'type' => 'play',
                    'position' => $requestedPos,
                    'track' => $this->rooms[$roomId]['current_track'] ?? null,
                    'server_time' => (int)(microtime(true) * 1000),
                    'triggered_by' => $meta['nickname'],
                ]);

                $this->roomManager->updatePlaybackState($roomId, 'playing', $requestedPos);
                break;

            case 'pause':
                $currentPos = $this->getCurrentPosition($roomId);
                $this->rooms[$roomId]['playback_state'] = 'paused';
                $this->rooms[$roomId]['position'] = $currentPos;
                $this->rooms[$roomId]['last_sync_timestamp'] = microtime(true);

                // Broadcast immediately to all clients with 0ms network latency
                $this->broadcastToRoom($roomId, [
                    'type' => 'pause',
                    'position' => $currentPos,
                    'track' => $this->rooms[$roomId]['current_track'] ?? null,
                    'server_time' => (int)(microtime(true) * 1000),
                    'triggered_by' => $meta['nickname'],
                ]);

                $this->roomManager->updatePlaybackState($roomId, 'paused', $currentPos);
                break;

            case 'seek':
                $newPos = (float)($data['position'] ?? 0.0);
                $this->rooms[$roomId]['position'] = $newPos;
                $this->rooms[$roomId]['last_sync_timestamp'] = microtime(true);

                // Broadcast immediately to all clients
                $this->broadcastToRoom($roomId, [
                    'type' => 'seek',
                    'position' => $newPos,
                    'state' => $this->rooms[$roomId]['playback_state'],
                    'track' => $this->rooms[$roomId]['current_track'] ?? null,
                    'server_time' => (int)(microtime(true) * 1000),
                    'triggered_by' => $meta['nickname'],
                ]);

                $this->roomManager->updatePlaybackState($roomId, $this->rooms[$roomId]['playback_state'], $newPos);
                break;

            case 'set_track':
                // Set current track and play
                $track = $data['track'] ?? null;
                if ($track && !empty($track['youtube_id'])) {
                    if (isset($track['id'])) {
                        $this->roomManager->markTrackPlayed($roomId, (int)$track['id']);
                    }
                    $this->setRoomTrack($roomId, $track);
                    $remainingQueue = $this->roomManager->getQueue($roomId);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'queue_updated',
                        'queue' => $remainingQueue,
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;

            case 'next':
                $now = microtime(true);
                $lastTrans = $this->rooms[$roomId]['last_track_transition'] ?? 0.0;
                if ($now - $lastTrans < 1.0) {
                    // Debounce: ignore rapid next clicks within 1.0s
                    break;
                }
                $this->rooms[$roomId]['last_track_transition'] = $now;
                $this->playNextInQueue($roomId, $meta['nickname']);
                break;

            case 'track_ended':
                $now = microtime(true);
                $lastTrans = $this->rooms[$roomId]['last_track_transition'] ?? 0.0;
                if ($now - $lastTrans < 3.0) {
                    // Debounce: multiple clients reaching track end within 3.0s are ignored
                    break;
                }
                $this->rooms[$roomId]['last_track_transition'] = $now;
                $this->handleTrackEnded($roomId);
                break;

            case 'set_loop':
                $mode = in_array($data['mode'] ?? '', ['off', 'one', 'all'], true) ? $data['mode'] : 'off';
                $this->rooms[$roomId]['loop_mode'] = $mode;
                $this->broadcastToRoom($roomId, [
                    'type' => 'loop_changed',
                    'loop_mode' => $mode,
                    'triggered_by' => $meta['nickname'],
                ]);
                break;

            case 'prev':
                $now = microtime(true);
                $lastTrans = $this->rooms[$roomId]['last_track_transition'] ?? 0.0;
                if ($now - $lastTrans < 1.0) {
                    // Debounce: ignore rapid prev clicks within 1.0s
                    break;
                }
                $this->rooms[$roomId]['last_track_transition'] = $now;
                $this->playPreviousInQueue($roomId, $meta['nickname']);
                break;

            case 'queue_add':
                $track = $data['track'] ?? null;
                if ($track && !empty($track['youtube_id'])) {
                    $added = $this->roomManager->addTrackToQueue($roomId, $track, $meta['nickname']);
                    if ($added === null) {
                        $from->send(json_encode([
                            'type' => 'notice',
                            'message' => 'Lagu ini sudah ada di antrean.',
                            'level' => 'warning',
                        ]));
                        break;
                    }

                    $queue = $this->roomManager->getQueue($roomId);

                    // If currently nothing is playing, start this track immediately
                    if ($this->rooms[$roomId]['current_track'] === null) {
                        $this->setRoomTrack($roomId, $added);
                    }

                    $this->broadcastToRoom($roomId, [
                        'type' => 'queue_updated',
                        'queue' => $queue,
                        'added_track' => $added,
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;

            case 'queue_reorder':
                $orderedIds = $data['ordered_ids'] ?? [];
                if (is_array($orderedIds) && !empty($orderedIds)) {
                    $reordered = $this->roomManager->reorderQueue($roomId, $orderedIds);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'queue_updated',
                        'queue' => $reordered,
                        'triggered_by' => $meta['nickname'],
                        'action' => 'reorder',
                    ]);
                }
                break;

            case 'queue_remove':
                $queueId = (int)($data['queue_id'] ?? 0);
                if ($queueId > 0) {
                    $item = $this->roomManager->getQueueItem($roomId, $queueId);
                    $this->roomManager->removeTrackFromQueue($roomId, $queueId);
                    $queue = $this->roomManager->getQueue($roomId);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'queue_updated',
                        'queue' => $queue,
                        'removed_track_title' => $item['title'] ?? '',
                        'triggered_by' => $meta['nickname'],
                        'action' => 'remove',
                    ]);
                }
                break;

            case 'queue_shuffle':
                $shuffled = $this->roomManager->shuffleQueue($roomId);
                $this->broadcastToRoom($roomId, [
                    'type' => 'queue_updated',
                    'queue' => $shuffled,
                    'triggered_by' => $meta['nickname'],
                    'action' => 'shuffle',
                ]);
                break;

            case 'playlist_add':
                $track = $data['track'] ?? null;
                if ($track && !empty($track['youtube_id'])) {
                    $added = $this->roomManager->addTrackToPlaylist($roomId, $track, $meta['nickname']);
                    if ($added === null) {
                        $from->send(json_encode([
                            'type' => 'notice',
                            'message' => 'Lagu ini sudah ada di Bank Musik.',
                            'level' => 'warning',
                        ]));
                        break;
                    }

                    $playlist = $this->roomManager->getPlaylist($roomId);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'playlist_updated',
                        'playlist' => $playlist,
                        'added_track' => $added,
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;

            case 'playlist_remove':
                $playlistId = (int)($data['playlist_id'] ?? 0);
                if ($playlistId > 0) {
                    $item = $this->roomManager->getPlaylistItem($roomId, $playlistId);
                    $this->roomManager->removeTrackFromPlaylist($roomId, $playlistId);
                    $playlist = $this->roomManager->getPlaylist($roomId);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'playlist_updated',
                        'playlist' => $playlist,
                        'removed_track_title' => $item['title'] ?? '',
                        'triggered_by' => $meta['nickname'],
                        'action' => 'remove',
                    ]);
                }
                break;

            case 'chat':
                $text = trim((string)($data['message'] ?? ''));
                if ($text !== '') {
                    $saved = $this->roomManager->saveChatMessage(
                        $roomId,
                        $meta['nickname'],
                        $meta['emoji'],
                        $text
                    );
                    $this->broadcastToRoom($roomId, [
                        'type' => 'chat_message',
                        'message' => $saved,
                    ]);
                }
                break;

            case 'soundboard_play':
                $this->broadcastToRoom($roomId, [
                    'type' => 'soundboard_play',
                    'sound_id' => $data['sound_id'] ?? '',
                    'title' => $data['title'] ?? 'Soundboard',
                    'emoji' => $data['emoji'] ?? '🔊',
                    'file_url' => $data['file_url'] ?? '',
                    'triggered_by' => $meta['nickname'],
                    'sender_emoji' => $meta['emoji'],
                ]);
                break;

            case 'soundboard_add':
                $soundboard = $data['soundboard'] ?? null;
                if ($soundboard) {
                    $this->broadcastToRoom($roomId, [
                        'type' => 'soundboard_added',
                        'soundboard' => $soundboard,
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;

            case 'soundboard_delete':
                $soundboardId = (int)($data['soundboard_id'] ?? 0);
                if ($soundboardId > 0) {
                    $this->broadcastToRoom($roomId, [
                        'type' => 'soundboard_deleted',
                        'soundboard_id' => $soundboardId,
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;

            case 'voice_chunk':
                $audio = $data['audio'] ?? '';
                if ($audio !== '') {
                    $this->broadcastToRoom($roomId, [
                        'type' => 'voice_chunk',
                        'audio' => $audio,
                        'mime' => $data['mime'] ?? 'pcm16',
                        'sample_rate' => (int)($data['sample_rate'] ?? 16000),
                        'seq' => (int)($data['seq'] ?? 0),
                        'channel' => $data['channel'] ?? 'general',
                        'sender_nickname' => $meta['nickname'],
                        'sender_emoji' => $meta['emoji'],
                    ], $from);
                }
                break;

            case 'voice_state':
                $this->broadcastToRoom($roomId, [
                    'type' => 'voice_state',
                    'speaking' => !empty($data['speaking']),
                    'channel' => $data['channel'] ?? 'general',
                    'sender_nickname' => $meta['nickname'],
                    'sender_emoji' => $meta['emoji'],
                ]);
                break;

            case 'game_start':
                $this->handleGameStart($roomId, $meta, $data);
                break;

            case 'punishment_clear':
                $targetDevId = $data['device_id'] ?? '';
                if ($targetDevId !== '' && isset($this->rooms[$roomId]['punishments'][$targetDevId])) {
                    $cleared = $this->rooms[$roomId]['punishments'][$targetDevId];
                    unset($this->rooms[$roomId]['punishments'][$targetDevId]);
                    $this->broadcastToRoom($roomId, [
                        'type' => 'punishments_updated',
                        'punishments' => array_values($this->rooms[$roomId]['punishments']),
                        'cleared_user' => $cleared['nickname'] ?? '',
                        'triggered_by' => $meta['nickname'],
                    ]);
                }
                break;
        }
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $resId = $conn->resourceId;
        if (!isset($this->clientMeta[$resId])) {
            return;
        }

        $meta = $this->clientMeta[$resId];
        $roomId = $meta['room_id'];

        unset($this->rooms[$roomId]['clients'][$resId]);
        unset($this->clientMeta[$resId]);

        $remainingCount = count($this->rooms[$roomId]['clients']);

        if ($remainingCount === 0) {
            $this->rooms[$roomId]['empty_since'] = time();
            $this->rooms[$roomId]['playback_state'] = 'paused';
            $currentPos = $this->getCurrentPosition($roomId);
            $this->roomManager->updatePlaybackState($roomId, 'paused', $currentPos);
            $this->roomManager->markEmptySince($roomId, true);
        } else {
            $this->broadcastToRoom($roomId, [
                'type' => 'user_left',
                'user' => [
                    'nickname' => $meta['nickname'],
                    'emoji' => $meta['emoji'],
                ],
                'online_users' => $this->getOnlineUsers($roomId),
            ]);
        }
    }

    public function onError(ConnectionInterface $conn, Exception $e): void
    {
        error_log("WebSocket Error: " . $e->getMessage());
        $conn->close();
    }

    /**
     * Periodic cleanup check for rooms empty > 10 minutes (600s)
     */
    public function checkInactivity(): void
    {
        $now = time();
        foreach ($this->rooms as $roomId => $room) {
            if (empty($room['clients']) && !empty($room['empty_since'])) {
                if ($now - $room['empty_since'] >= 600) {
                    echo "[CLEANUP] Room {$roomId} was empty for 10 minutes. Destroying room.\n";
                    unset($this->rooms[$roomId]);
                }
            }
        }

        $purgedCount = $this->roomManager->purgeInactiveRooms(600);
        if ($purgedCount > 0) {
            echo "[CLEANUP] Purged {$purgedCount} inactive room(s) from database.\n";
        }
    }

    private function setRoomTrack(string $roomId, array $track): void
    {
        $this->rooms[$roomId]['current_track'] = $track;
        $this->rooms[$roomId]['playback_state'] = 'playing';
        $this->rooms[$roomId]['position'] = 0.0;
        $this->rooms[$roomId]['last_sync_timestamp'] = microtime(true);
        $this->rooms[$roomId]['last_track_transition'] = microtime(true);

        // Broadcast to clients immediately with 0ms network latency
        $this->broadcastToRoom($roomId, [
            'type' => 'track_change',
            'track' => $track,
            'position' => 0.0,
            'state' => 'playing',
            'server_time' => (int)(microtime(true) * 1000),
        ]);

        $this->roomManager->updatePlaybackState($roomId, 'playing', 0.0, $track['youtube_id'] ?? null);
    }

    private function playPreviousInQueue(string $roomId, string $triggeredBy = ''): void
    {
        if (!isset($this->rooms[$roomId])) {
            return;
        }

        $history = &$this->rooms[$roomId]['history'];
        if (empty($history)) {
            // Tidak ada riwayat lagu sebelumnya: ulang lagu saat ini dari awal
            $this->rooms[$roomId]['position'] = 0.0;
            $this->rooms[$roomId]['last_sync_timestamp'] = microtime(true);
            $this->roomManager->updatePlaybackState($roomId, $this->rooms[$roomId]['playback_state'], 0.0);

            $this->broadcastToRoom($roomId, [
                'type' => 'seek',
                'position' => 0.0,
                'state' => $this->rooms[$roomId]['playback_state'],
                'server_time' => (int)(microtime(true) * 1000),
                'triggered_by' => $triggeredBy,
            ]);
            return;
        }

        $prevTrack = array_pop($history);
        $currentTrack = $this->rooms[$roomId]['current_track'];

        // Kembalikan lagu yang saat ini diputar ke posisi PALING ATAS antrean agar tidak hilang
        if ($currentTrack !== null) {
            $this->roomManager->prependTrackToQueue($roomId, $currentTrack);
        }

        $this->setRoomTrack($roomId, $prevTrack);

        $remainingQueue = $this->roomManager->getQueue($roomId);
        $this->broadcastToRoom($roomId, [
            'type' => 'queue_updated',
            'queue' => $remainingQueue,
            'triggered_by' => $triggeredBy,
        ]);
    }

    private function playNextInQueue(string $roomId, string $triggeredBy = ''): void
    {
        if (!isset($this->rooms[$roomId])) {
            return;
        }

        $currentTrack = $this->rooms[$roomId]['current_track'];
        $loopMode = $this->rooms[$roomId]['loop_mode'] ?? 'off';

        if ($currentTrack !== null) {
            // Simpan track saat ini ke riwayat playback
            $this->rooms[$roomId]['history'][] = $currentTrack;

            // Jika Loop All Queue: masukkan kembali ke ujung antrean agar antrean berputar terus tanpa hilang
            if ($loopMode === 'all') {
                if (isset($currentTrack['id'])) {
                    $this->roomManager->moveTrackToEndOfQueue($roomId, (int)$currentTrack['id']);
                } else {
                    $this->roomManager->addTrackToQueue($roomId, $currentTrack, $currentTrack['added_by_nickname'] ?? 'Jamri');
                }
            }
        }

        $queue = $this->roomManager->getQueue($roomId);
        if (empty($queue)) {
            $this->rooms[$roomId]['playback_state'] = 'stopped';
            $this->rooms[$roomId]['current_track'] = null;
            $this->rooms[$roomId]['position'] = 0.0;
            $this->roomManager->updatePlaybackState($roomId, 'stopped', 0.0);

            $this->broadcastToRoom($roomId, [
                'type' => 'playback_stopped',
                'server_time' => (int)(microtime(true) * 1000),
                'triggered_by' => $triggeredBy,
            ]);
            return;
        }

        $nextTrack = array_shift($queue);
        if (isset($nextTrack['id'])) {
            $this->roomManager->markTrackPlayed($roomId, (int)$nextTrack['id']);
        }

        $this->setRoomTrack($roomId, $nextTrack);

        $remainingQueue = $this->roomManager->getQueue($roomId);
        $this->broadcastToRoom($roomId, [
            'type' => 'queue_updated',
            'queue' => $remainingQueue,
            'triggered_by' => $triggeredBy,
        ]);
    }

    private function handleTrackEnded(string $roomId): void
    {
        if (!isset($this->rooms[$roomId])) {
            return;
        }

        $loopMode = $this->rooms[$roomId]['loop_mode'] ?? 'off';
        $currentTrack = $this->rooms[$roomId]['current_track'];

        if ($loopMode === 'one' && $currentTrack !== null) {
            // Loop 1 song: ulang lagu yang sama terus menerus
            $this->setRoomTrack($roomId, $currentTrack);
            return;
        }

        $this->playNextInQueue($roomId, 'Auto');
    }

    private function getCurrentPosition(string $roomId): float
    {
        if (!isset($this->rooms[$roomId])) {
            return 0.0;
        }

        $room = $this->rooms[$roomId];
        $pos = (float)$room['position'];

        if ($room['playback_state'] === 'playing') {
            $delta = microtime(true) - (float)$room['last_sync_timestamp'];
            $pos += max(0.0, $delta);
        }

        return round($pos, 2);
    }

    private function getOnlineUsers(string $roomId): array
    {
        if (!isset($this->rooms[$roomId])) {
            return [];
        }

        $hostDeviceId = '';
        $roomSummary = $this->roomManager->getRoomSummary($roomId);
        if ($roomSummary) {
            $hostDeviceId = (string)($roomSummary['host_device_id'] ?? '');
        }

        $users = [];
        foreach ($this->rooms[$roomId]['clients'] as $resId => $conn) {
            if (isset($this->clientMeta[$resId])) {
                $meta = $this->clientMeta[$resId];
                $devId = (string)$meta['device_id'];
                // Distinguish users by device ID and nickname to allow multi-tab testing
                $uniqueKey = $devId . '_' . $meta['nickname'];
                $users[$uniqueKey] = [
                    'nickname' => $meta['nickname'],
                    'emoji' => $meta['emoji'],
                    'device_id' => $devId,
                    'is_host' => ($devId !== '' && $devId === $hostDeviceId),
                ];
            }
        }

        return array_values($users);
    }

    private function broadcastToRoom(string $roomId, array $payload, ?ConnectionInterface $exclude = null): void
    {
        if (!isset($this->rooms[$roomId])) {
            return;
        }

        $json = json_encode($payload);
        foreach ($this->rooms[$roomId]['clients'] as $resId => $conn) {
            if ($exclude !== null && $conn === $exclude) {
                continue;
            }
            try {
                $conn->send($json);
            } catch (\Throwable $e) {
                // If a connection dropped or failed, ignore and continue to others
            }
        }
    }

    private function handleGameStart(string $roomId, array $meta, array $data): void
    {
        $gameType = in_array($data['game_type'] ?? '', ['dice', 'number', 'wheel'], true) ? $data['game_type'] : 'dice';
        $penaltyMinutes = max(1, min(15, (int)($data['penalty_minutes'] ?? 2)));

        $now = time();
        $cooldownUntil = (int)($this->rooms[$roomId]['game_cooldown_until'] ?? 0);
        if ($now < $cooldownUntil) {
            $remaining = $cooldownUntil - $now;
            $this->broadcastToRoom($roomId, [
                'type' => 'game_cooldown_active',
                'remaining' => $remaining,
                'cooldown_until' => $cooldownUntil,
                'message' => "Tunggu {$remaining} detik sebelum memulai game berikutnya.",
            ]);
            return;
        }

        // Cooldown: penaltyMinutes - 1 minute (minimal 30 detik) agar tidak bisa spam game
        $cooldownDuration = max(30, ($penaltyMinutes - 1) * 60);
        $this->rooms[$roomId]['game_cooldown_until'] = $now + $cooldownDuration;

        $onlineUsers = $this->getOnlineUsers($roomId);
        if (empty($onlineUsers)) {
            // Fallback to sender if room online list had a timing gap
            $onlineUsers = [[
                'nickname' => $meta['nickname'] ?? 'Player',
                'emoji' => $meta['emoji'] ?? '🎧',
                'device_id' => $meta['device_id'] ?? 'dev_guest',
                'is_host' => true,
            ]];
        }

        $gameTitles = [
            'dice' => 'Adu Dadu',
            'number' => 'Adu Angka',
            'wheel' => 'Roulette Spin',
        ];
        $gameName = $gameTitles[$gameType] ?? 'Mini Game';

        $participants = [];
        $loser = null;
        $animationMs = 4500;

        if ($gameType === 'dice') {
            $minScore = 999;
            $loserCandidates = [];
            foreach ($onlineUsers as $idx => $u) {
                $d1 = mt_rand(1, 6);
                $d2 = mt_rand(1, 6);
                $total = $d1 + $d2;
                $pData = [
                    'id' => 'p_' . $idx,
                    'index' => $idx,
                    'nickname' => $u['nickname'],
                    'emoji' => $u['emoji'],
                    'device_id' => $u['device_id'],
                    'die1' => $d1,
                    'die2' => $d2,
                    'score' => $total,
                ];
                $participants[] = $pData;

                if ($total < $minScore) {
                    $minScore = $total;
                    $loserCandidates = [$pData];
                } elseif ($total === $minScore) {
                    $loserCandidates[] = $pData;
                }
            }

            $loserKey = array_rand($loserCandidates);
            $loser = $loserCandidates[$loserKey];
            $animationMs = 4000;

        } elseif ($gameType === 'number') {
            $usedNumbers = [];
            $minScore = 999;
            $loserCandidates = [];
            foreach ($onlineUsers as $idx => $u) {
                do {
                    $score = mt_rand(1, 100);
                } while (in_array($score, $usedNumbers, true) && count($usedNumbers) < 100);
                $usedNumbers[] = $score;

                $pData = [
                    'id' => 'p_' . $idx,
                    'index' => $idx,
                    'nickname' => $u['nickname'],
                    'emoji' => $u['emoji'],
                    'device_id' => $u['device_id'],
                    'score' => $score,
                ];
                $participants[] = $pData;

                if ($score < $minScore) {
                    $minScore = $score;
                    $loserCandidates = [$pData];
                } elseif ($score === $minScore) {
                    $loserCandidates[] = $pData;
                }
            }
            $loserKey = array_rand($loserCandidates);
            $loser = $loserCandidates[$loserKey];
            $animationMs = 4500;

        } else { // wheel
            foreach ($onlineUsers as $idx => $u) {
                $participants[] = [
                    'id' => 'p_' . $idx,
                    'index' => $idx,
                    'nickname' => $u['nickname'],
                    'emoji' => $u['emoji'],
                    'device_id' => $u['device_id'],
                ];
            }

            $loserIndex = array_rand($participants);
            $loser = $participants[$loserIndex];

            $count = count($participants);
            $sliceDeg = 360 / max(1, $count);
            $jitter = ($sliceDeg * 0.3) * ((mt_rand(-80, 80)) / 100.0);
            $sliceCenter = ($loserIndex * $sliceDeg) + ($sliceDeg / 2.0) + $jitter;
            $rotations = 5;
            $landingDeg = ($rotations * 360) + (360 - fmod($sliceCenter - 270 + 360, 360));

            $animationMs = 6500;
        }

        // Apply penalty to the loser (akumulasi jika kalah berkali-kali)
        $existingUntil = (int)($this->rooms[$roomId]['punishments'][$loser['device_id']]['until'] ?? 0);
        $baseTime = max($now, $existingUntil);
        $until = $baseTime + ($penaltyMinutes * 60);

        $punishment = [
            'id' => uniqid('punish_'),
            'nickname' => $loser['nickname'],
            'device_id' => $loser['device_id'],
            'emoji' => $loser['emoji'] ?? '🎧',
            'game_type' => $gameType,
            'game_name' => $gameName,
            'penalty_minutes' => $penaltyMinutes,
            'until' => $until,
            'created_at' => $now,
        ];

        if (!isset($this->rooms[$roomId]['punishments'])) {
            $this->rooms[$roomId]['punishments'] = [];
        }
        $this->rooms[$roomId]['punishments'][$loser['device_id']] = $punishment;

        $gamePayload = [
            'type' => 'game_started',
            'game_id' => uniqid('gm_'),
            'game_type' => $gameType,
            'game_name' => $gameName,
            'penalty_minutes' => $penaltyMinutes,
            'cooldown_until' => $this->rooms[$roomId]['game_cooldown_until'],
            'started_by' => $meta['nickname'],
            'started_by_emoji' => $meta['emoji'],
            'participants' => $participants,
            'loser' => $loser,
            'landing_deg' => isset($landingDeg) ? $landingDeg : 0,
            'animation_ms' => $animationMs,
            'punishment' => $punishment,
            'server_time' => (int)(microtime(true) * 1000),
        ];

        $this->broadcastToRoom($roomId, $gamePayload);

        // Broadcast updated punishments list
        $this->broadcastToRoom($roomId, [
            'type' => 'punishments_updated',
            'punishments' => array_values($this->rooms[$roomId]['punishments']),
            'cooldown_until' => $this->rooms[$roomId]['game_cooldown_until'],
        ]);
    }

    public function isUserPunished(string $roomId, string $deviceId, string $nickname): bool
    {
        $this->cleanExpiredPunishments($roomId);
        if (!isset($this->rooms[$roomId]['punishments'])) {
            return false;
        }

        foreach ($this->rooms[$roomId]['punishments'] as $p) {
            if (($deviceId !== '' && $p['device_id'] === $deviceId) || ($nickname !== '' && $p['nickname'] === $nickname)) {
                if ($p['until'] > time()) {
                    return true;
                }
            }
        }
        return false;
    }

    public function getUserPunishment(string $roomId, string $deviceId, string $nickname): ?array
    {
        $this->cleanExpiredPunishments($roomId);
        if (!isset($this->rooms[$roomId]['punishments'])) {
            return null;
        }

        foreach ($this->rooms[$roomId]['punishments'] as $p) {
            if (($deviceId !== '' && $p['device_id'] === $deviceId) || ($nickname !== '' && $p['nickname'] === $nickname)) {
                if ($p['until'] > time()) {
                    return $p;
                }
            }
        }
        return null;
    }

    public function getActivePunishments(string $roomId): array
    {
        $this->cleanExpiredPunishments($roomId);
        if (!isset($this->rooms[$roomId]['punishments'])) {
            return [];
        }
        return array_values($this->rooms[$roomId]['punishments']);
    }

    public function cleanExpiredPunishments(string $roomId): void
    {
        if (!isset($this->rooms[$roomId]['punishments'])) {
            return;
        }

        $now = time();
        $expiredCount = 0;
        foreach ($this->rooms[$roomId]['punishments'] as $key => $p) {
            if ($p['until'] <= $now) {
                unset($this->rooms[$roomId]['punishments'][$key]);
                $expiredCount++;
            }
        }

        if ($expiredCount > 0) {
            $this->broadcastToRoom($roomId, [
                'type' => 'punishments_updated',
                'punishments' => array_values($this->rooms[$roomId]['punishments']),
            ]);
        }
    }

    public function persistRuntimeState(): void
    {
        $file = dirname(__DIR__) . '/data/runtime_rooms.json';
        $data = [
            'saved_at' => microtime(true),
            'rooms' => [],
        ];

        foreach ($this->rooms as $roomId => $room) {
            $data['rooms'][$roomId] = [
                'current_track' => $room['current_track'] ?? null,
                'playback_state' => $room['playback_state'] ?? 'stopped',
                'position' => $this->getCurrentPosition($roomId),
                'loop_mode' => $room['loop_mode'] ?? 'off',
                'is_shuffled' => !empty($room['is_shuffled']),
                'punishments' => $room['punishments'] ?? [],
                'history' => $room['history'] ?? [],
            ];
        }

        @file_put_contents($file, json_encode($data), LOCK_EX);
    }

    private function restoreRuntimeState(): void
    {
        $file = dirname(__DIR__) . '/data/runtime_rooms.json';
        if (!file_exists($file)) {
            return;
        }

        $raw = @file_get_contents($file);
        if (!$raw) {
            return;
        }

        $data = json_decode($raw, true);
        if (!$data || empty($data['saved_at']) || empty($data['rooms'])) {
            return;
        }

        $now = microtime(true);
        $elapsed = $now - (float)$data['saved_at'];

        // Only restore if snapshot is fresh (< 10 minutes old)
        if ($elapsed > 600.0) {
            @unlink($file);
            return;
        }

        foreach ($data['rooms'] as $roomId => $saved) {
            $state = $saved['playback_state'] ?? 'stopped';
            $pos = (float)($saved['position'] ?? 0.0);

            // If it was actively playing, smoothly advance position by the downtime seconds
            if ($state === 'playing') {
                $pos += max(0.0, $elapsed);
            }

            $this->rooms[$roomId] = [
                'clients' => [],
                'current_track' => $saved['current_track'] ?? null,
                'playback_state' => $state,
                'position' => $pos,
                'last_sync_timestamp' => $now,
                'last_track_transition' => $now,
                'empty_since' => null,
                'loop_mode' => $saved['loop_mode'] ?? 'off',
                'history' => $saved['history'] ?? [],
                'is_shuffled' => !empty($saved['is_shuffled']),
                'punishments' => $saved['punishments'] ?? [],
            ];
        }
    }
}
