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
    /** Hard ceiling for an inbound websocket frame (~256 KB). */
    private const MAX_FRAME_BYTES = 262144;
    /** Base64 audio payload ceiling for voice/soundboard (~96 KB decoded). */
    private const MAX_AUDIO_CHARS = 131072;
    /** Cap the in-memory play history to prevent unbounded growth. */
    private const MAX_HISTORY = 50;

    private RoomManager $roomManager;
    private YouTubeService $ytService;
    private RateLimiter $rateLimiter;
    private WorldManager $worldManager;

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
    /**
     * Map resourceId => ['mode' => 'room'|'world', 'room_id', 'device_id', 'nickname', 'emoji']
     */
    private array $clientMeta = [];

    /** resourceId => ConnectionInterface for world-mode clients only. */
    private array $worldConnections = [];

    /** Counts world ticks so periodic mat maintenance can run less often. */
    private int $worldTickCounter = 0;

    /** worldId => [resId => true]: mats whose choice dialog is already open client-side. */
    private array $pendingChoice = [];

    public function __construct(RoomManager $roomManager, YouTubeService $ytService, ?WorldManager $worldManager = null)
    {
        $this->roomManager = $roomManager;
        $this->ytService = $ytService;
        $this->rateLimiter = new RateLimiter();
        $this->worldManager = $worldManager ?? new WorldManager($roomManager->pdo(), $roomManager);
        $this->restoreRuntimeState();
        register_shutdown_function([$this, 'persistRuntimeState']);
    }

    public function onOpen(ConnectionInterface $conn): void
    {
        // Parse query params from request
        $queryString = $conn->httpRequest->getUri()->getQuery();
        parse_str($queryString, $params);

        $roomId = Validator::roomId($params['room_id'] ?? '');
        $deviceId = Validator::deviceId($params['device_id'] ?? '');
        $nickname = Validator::nickname($params['nickname'] ?? 'Guest', 'Guest');
        $emoji = Validator::emoji($params['emoji'] ?? '');
        $worldMode = ($params['mode'] ?? '') === 'world';

        if ($roomId === '' || $deviceId === '') {
            $conn->send(json_encode(['type' => 'error', 'message' => 'room_id and device_id are required']));
            $conn->close();
            return;
        }

        // Throttle connection churn per device (reconnect storms / socket floods).
        if (!$this->rateLimiter->allow(RateLimiter::key('ws_open', $deviceId), 30, 60)) {
            $conn->send(json_encode(['type' => 'error', 'message' => 'Terlalu banyak koneksi. Coba lagi sebentar.']));
            $conn->close();
            return;
        }

        if ($worldMode) {
            $this->openWorld($conn, $roomId, $deviceId, $nickname, $emoji);
            return;
        }

        $resId = $conn->resourceId;
        $this->clientMeta[$resId] = [
            'mode' => 'room',
            'room_id' => $roomId,
            'device_id' => $deviceId,
            'nickname' => $nickname,
            'emoji' => $emoji,
        ];

        if (!$this->attachToRoom($conn, $roomId)) {
            $conn->send(json_encode([
                'type' => 'room_not_found',
                'message' => 'Room ini sudah kedaluwarsa atau telah dihapus karena tidak ada aktivitas.'
            ]));
            $conn->close();
        }
    }

    /**
     * Attach a connection to a room's live audio session: load state from DB on
     * first join, register the client, send room_init and announce the join.
     * Shared by the legacy flow and world "mat" joins.
     *
     * @return bool false when the room does not exist.
     */
    private function attachToRoom(ConnectionInterface $conn, string $roomId): bool
    {
        $resId = $conn->resourceId;
        $meta = $this->clientMeta[$resId] ?? [];
        $nickname = $meta['nickname'] ?? 'Guest';
        $emoji = $meta['emoji'] ?? '🎧';
        $deviceId = $meta['device_id'] ?? '';

        if (!isset($this->rooms[$roomId])) {
            // Load state from DB
            $roomSummary = $this->roomManager->getRoomSummary($roomId);
            if (!$roomSummary) {
                return false;
            }
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
                'host_device_id' => (string)($roomSummary['host_device_id'] ?? ''),
                'control_mode' => (string)($roomSummary['box_control'] ?? 'everyone'),
            ];
        }

        $this->rooms[$roomId]['clients'][$resId] = $conn;
        $this->rooms[$roomId]['empty_since'] = null;
        $this->roomManager->markEmptySince($roomId, false);

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
            'control_mode' => $this->rooms[$roomId]['control_mode'] ?? 'everyone',
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

        return true;
    }

    /**
     * Detach a connection from a room's audio session. When the last client
     * leaves, pause playback and mark the room empty for auto-purge.
     */
    private function detachFromRoom(string $roomId, int $resId, array $meta): void
    {
        if (!isset($this->rooms[$roomId])) {
            return;
        }

        unset($this->rooms[$roomId]['clients'][$resId]);

        if (count($this->rooms[$roomId]['clients']) === 0) {
            $this->rooms[$roomId]['empty_since'] = time();
            $this->rooms[$roomId]['playback_state'] = 'paused';
            $currentPos = $this->getCurrentPosition($roomId);
            $this->roomManager->updatePlaybackState($roomId, 'paused', $currentPos);
            $this->roomManager->markEmptySince($roomId, true);
        } else {
            $this->broadcastToRoom($roomId, [
                'type' => 'user_left',
                'user' => [
                    'nickname' => $meta['nickname'] ?? 'Guest',
                    'emoji' => $meta['emoji'] ?? '🎧',
                ],
                'online_users' => $this->getOnlineUsers($roomId),
            ]);
        }
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        $resId = $from->resourceId;
        if (!isset($this->clientMeta[$resId])) {
            return;
        }

        $meta = $this->clientMeta[$resId];

        // Cheap guard before any decoding: reject oversized frames outright so a
        // single client cannot exhaust daemon memory with a huge JSON blob.
        if (!is_string($msg) || strlen($msg) > self::MAX_FRAME_BYTES) {
            return;
        }

        // Per-device message flood protection (covers ping/chat/game spam).
        // Kept generous because real-time voice PTT streams ~12 chunks/second;
        // tighter per-action limits below handle the sensitive operations.
        if (!$this->rateLimiter->allow(RateLimiter::key('ws_msg', $meta['device_id']), 400, 10)) {
            return;
        }

        $data = json_decode($msg, true);

        if (!$data || empty($data['type']) || !is_string($data['type'])) {
            return;
        }

        $type = $data['type'];

        // World protocol owns movement + mat management. Any OTHER message from a
        // world client is a room-bound action (play/pause/chat/queue...) and is
        // only valid while the avatar is standing on a mat.
        if (($meta['mode'] ?? 'room') === 'world') {
            if (in_array($type, ['world.move', 'zone.select', 'mat.place', 'mat.pickup', 'world.chat', 'world.emote', 'ping'], true)) {
                $this->handleWorldMessage($from, $meta, $type, $data);
                return;
            }

            $activeBoxId = $this->worldManager->getActiveBox($meta['room_id'], $resId);
            $activeBox = $activeBoxId !== null ? $this->worldManager->getBox($meta['room_id'], $activeBoxId) : null;
            if ($activeBox === null) {
                // Not on a mat: room actions have no target.
                return;
            }
            $roomId = $activeBox['room_id'];
        } else {
            $roomId = $meta['room_id'];
        }

        // Guard: Check if music control action is attempted by a currently punished user
        $musicControlActions = [
            'play', 'pause', 'seek', 'set_track', 'next', 'prev',
            'set_loop', 'queue_add', 'queue_reorder', 'queue_remove',
            'queue_shuffle', 'playlist_add', 'playlist_remove'
        ];

        // Mat control policy: when a mat is set to 'owner', only the mat owner
        // may drive playback. Enforced server-side (never trust the client).
        if (in_array($type, $musicControlActions, true) && ($meta['mode'] ?? 'room') === 'world') {
            $control = $this->rooms[$roomId]['control_mode'] ?? 'everyone';
            if ($control === 'owner') {
                $summary = $this->roomManager->getRoomSummary($roomId);
                $owner = $summary['host_device_id'] ?? '';
                if ($owner !== '' && $owner !== $meta['device_id']) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => 'Tikar ini hanya bisa dikontrol oleh pemiliknya.',
                        'level' => 'warning',
                    ]));
                    return;
                }
            }
        }

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

        try {
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

                $requestedPos = isset($data['position']) ? Validator::position($data['position']) : $this->getCurrentPosition($roomId);
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
                $newPos = Validator::position($data['position'] ?? 0.0);
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
                $track = Validator::track($data['track'] ?? []);
                if ($track !== null) {
                    if (isset($track['id'])) {
                        $this->roomManager->markTrackPlayed($roomId, (int)$track['id']);
                    }
                    $this->setRoomTrack($roomId, $track, $meta['nickname']);
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
                $mode = Validator::loopMode($data['mode'] ?? 'off');
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
                $track = Validator::track($data['track'] ?? []);
                if ($track !== null) {
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
                        $this->setRoomTrack($roomId, $added, $meta['nickname']);
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
                    // Only accept ids that actually belong to this room's live queue.
                    $validIds = array_map(
                        static fn($row) => (int)$row['id'],
                        $this->roomManager->getQueue($roomId)
                    );
                    $safeIds = [];
                    foreach ($orderedIds as $oid) {
                        $oid = (int)$oid;
                        if ($oid > 0 && in_array($oid, $validIds, true)) {
                            $safeIds[] = $oid;
                        }
                    }
                    if (empty($safeIds)) {
                        break;
                    }
                    $reordered = $this->roomManager->reorderQueue($roomId, $safeIds);
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
                // Support both a single "track" and a bulk "tracks" array (playlist import).
                $incoming = [];
                if (is_array($data['tracks'] ?? null)) {
                    $incoming = array_slice($data['tracks'], 0, 150);
                } elseif (is_array($data['track'] ?? null)) {
                    $incoming = [$data['track']];
                }

                // Bulk import is heavier: throttle separately.
                if (count($incoming) > 3 && !$this->rateLimiter->allow(RateLimiter::key('playlist_bulk', $meta['device_id']), 3, 120)) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => 'Terlalu banyak import playlist. Coba lagi nanti.',
                        'level' => 'warning',
                    ]));
                    break;
                }

                $addedList = [];
                foreach ($incoming as $rawTrack) {
                    if (!is_array($rawTrack)) {
                        continue;
                    }
                    $track = Validator::track($rawTrack);
                    if ($track === null) {
                        continue;
                    }
                    $added = $this->roomManager->addTrackToPlaylist($roomId, $track, $meta['nickname']);
                    if ($added !== null) {
                        $addedList[] = $added;
                    }
                }

                if (empty($addedList)) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => count($incoming) > 1
                            ? 'Semua lagu pada playlist ini sudah ada di Bank Musik.'
                            : 'Lagu ini sudah ada di Bank Musik.',
                        'level' => 'warning',
                    ]));
                    break;
                }

                $playlist = $this->roomManager->getPlaylist($roomId);
                $this->broadcastToRoom($roomId, [
                    'type' => 'playlist_updated',
                    'playlist' => $playlist,
                    'added_track' => $addedList[0],
                    'added_count' => count($addedList),
                    'triggered_by' => $meta['nickname'],
                ]);
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
                $text = Validator::chatMessage($data['message'] ?? '');
                if ($text !== '') {
                    // Anti-spam: at most 5 messages per 4 seconds per device.
                    if (!$this->rateLimiter->allow(RateLimiter::key('chat', $meta['device_id']), 5, 4)) {
                        $from->send(json_encode([
                            'type' => 'notice',
                            'message' => 'Pelan-pelan ya, pesan kamu terlalu cepat.',
                            'level' => 'warning',
                        ]));
                        break;
                    }
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
                $title = Validator::clean($data['title'] ?? 'Soundboard', Validator::MAX_SOUND_TITLE_LEN) ?: 'Soundboard';
                $emoji = Validator::emoji($data['emoji'] ?? '');
                $soundId = Validator::clean($data['sound_id'] ?? $data['id'] ?? '', 64);
                $fileUrl = (string)($data['file_url'] ?? '');

                // Audio must be a bounded base64 blob. file_url is not trusted and
                // is dropped entirely to avoid broadcasting arbitrary URLs.
                $audioData = (string)($data['audio'] ?? '');
                if ($audioData !== '' && (strlen($audioData) > self::MAX_AUDIO_CHARS || !preg_match('#^data:audio/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+$#i', $audioData))) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => 'Ukuran atau format soundboard tidak didukung.',
                        'level' => 'warning',
                    ]));
                    break;
                }

                // Anti-spam: at most 12 sounds per 6 seconds.
                if (!$this->rateLimiter->allow(RateLimiter::key('soundboard', $meta['device_id']), 12, 6)) {
                    break;
                }

                $this->broadcastToRoom($roomId, [
                    'type' => 'soundboard_play',
                    'sound_id' => $soundId,
                    'title' => $title,
                    'emoji' => $emoji,
                    'audio' => $audioData,
                    'file_url' => '',
                    'triggered_by' => $meta['nickname'],
                    'sender_emoji' => $meta['emoji'],
                ]);
                break;

            case 'voice_chunk':
                $audio = (string)($data['audio'] ?? '');
                if ($audio === '' || strlen($audio) > self::MAX_AUDIO_CHARS || !preg_match('#^[A-Za-z0-9+/=]+$#', $audio)) {
                    break;
                }
                // Voice flood protection: generous enough for smooth audio, hard
                // enough to stop amplification abuse.
                if (!$this->rateLimiter->allow(RateLimiter::key('voice', $meta['device_id']), 60, 3)) {
                    break;
                }
                $this->broadcastToRoom($roomId, [
                    'type' => 'voice_chunk',
                    'audio' => $audio,
                    'mime' => 'pcm16',
                    'sample_rate' => max(8000, min(48000, (int)($data['sample_rate'] ?? 16000))),
                    'seq' => (int)($data['seq'] ?? 0),
                    'channel' => in_array($data['channel'] ?? '', ['general', 'karaoke'], true) ? $data['channel'] : 'general',
                    'sender_nickname' => $meta['nickname'],
                    'sender_emoji' => $meta['emoji'],
                ], $from);
                break;

            case 'voice_state':
                $this->broadcastToRoom($roomId, [
                    'type' => 'voice_state',
                    'speaking' => !empty($data['speaking']),
                    'channel' => in_array($data['channel'] ?? '', ['general', 'karaoke'], true) ? $data['channel'] : 'general',
                    'sender_nickname' => $meta['nickname'],
                    'sender_emoji' => $meta['emoji'],
                ]);
                break;

            case 'karaoke_mute_toggle':
                $muted = !empty($data['muted']);
                $this->broadcastToRoom($roomId, [
                    'type' => 'karaoke_mute_toggle',
                    'muted' => $muted,
                    'user' => $meta['nickname'],
                    'emoji' => $meta['emoji'],
                    'device_id' => $meta['device_id'],
                ]);
                break;

            case 'game_start':
                $this->handleGameStart($roomId, $meta, $data);
                break;

            case 'punishment_clear':
                $targetDevId = Validator::deviceId($data['device_id'] ?? '');
                if ($targetDevId !== '') {
                    // Only the room host, or the punished user themselves, may clear
                    // a penalty. This stops anyone from lifting another player's
                    // (or their own) sanction.
                    $hostDeviceId = (string)($this->rooms[$roomId]['host_device_id'] ?? '');
                    if ($hostDeviceId === '') {
                        $roomSummary = $this->roomManager->getRoomSummary($roomId);
                        $hostDeviceId = $roomSummary ? (string)$roomSummary['host_device_id'] : '';
                        $this->rooms[$roomId]['host_device_id'] = $hostDeviceId;
                    }
                    $isHost = $hostDeviceId !== '' && $hostDeviceId === $meta['device_id'];
                    $isSelf = $targetDevId === $meta['device_id'];

                    if ((!$isHost && !$isSelf) || !isset($this->rooms[$roomId]['punishments'][$targetDevId])) {
                        $from->send(json_encode([
                            'type' => 'notice',
                            'message' => 'Hanya host yang bisa membatalkan sanksi pemain lain.',
                            'level' => 'warning',
                        ]));
                        break;
                    }

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
        } catch (\Throwable $e) {
            error_log("[WebSocket onMessage Error]: " . $e->getMessage());
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

        // World presence: detach from any active mat, then drop the avatar.
        if (($meta['mode'] ?? 'room') === 'world') {
            $activeBox = $this->worldManager->getActiveBox($roomId, $resId);
            if ($activeBox !== null) {
                // Detach the mat's backing audio room, NOT the world id: passing the
                // world id here left the real room's client list stale.
                $box = $this->worldManager->getBox($roomId, $activeBox);
                if ($box !== null) {
                    $this->detachFromRoom($box['room_id'], $resId, $meta);
                }
                if ($this->worldManager->activeUsersInBox($roomId, $activeBox) <= 1) {
                    $this->worldManager->markBoxEmpty($activeBox, true);
                }
                $this->worldManager->setActiveBox($roomId, $resId, null);
            }
            unset($this->clientMeta[$resId]);
            unset($this->worldConnections[$resId]);
            unset($this->pendingChoice[$roomId][$resId]);
            $this->worldManager->leave($roomId, $resId);
            $online = $this->worldManager->count($roomId);
            if ($online === 0) {
                $this->roomManager->markEmptySince($roomId, true);
            }
            $this->broadcastWorld($roomId, [
                'type' => 'world.leave',
                'id' => $resId,
                'online' => $online,
            ]);
            return;
        }

        // A client that failed to attach (unknown/purged room) closed already, but
        // its meta is still set. Without this guard count() runs on a missing room
        // and throws a TypeError, which Ratchet's catch(\Exception) does not catch,
        // taking the whole daemon down.
        if (!isset($this->rooms[$roomId])) {
            unset($this->clientMeta[$resId]);
            return;
        }

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

        // Keep the in-memory rate-limit map from growing forever.
        $this->rateLimiter->gc();

        $purgedCount = $this->roomManager->purgeInactiveRooms(600);
        if ($purgedCount > 0) {
            echo "[CLEANUP] Purged {$purgedCount} inactive room(s) from database.\n";
        }
    }

    private function setRoomTrack(string $roomId, array $track, string $triggeredBy = ''): void
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
            'triggered_by' => $triggeredBy,
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

        $this->setRoomTrack($roomId, $prevTrack, $triggeredBy);

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
            // Cap the in-memory history so a long-running daemon cannot leak memory.
            if (count($this->rooms[$roomId]['history']) > self::MAX_HISTORY) {
                $this->rooms[$roomId]['history'] = array_slice(
                    $this->rooms[$roomId]['history'],
                    -self::MAX_HISTORY
                );
            }

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

        $this->setRoomTrack($roomId, $nextTrack, $triggeredBy);

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
            $this->setRoomTrack($roomId, $currentTrack, 'Auto');
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

        $hostDeviceId = (string)($this->rooms[$roomId]['host_device_id'] ?? '');
        if ($hostDeviceId === '') {
            // Cached host id was missing (e.g. restored snapshot): resolve once.
            $roomSummary = $this->roomManager->getRoomSummary($roomId);
            if ($roomSummary) {
                $hostDeviceId = (string)($roomSummary['host_device_id'] ?? '');
                $this->rooms[$roomId]['host_device_id'] = $hostDeviceId;
            }
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
                'host_device_id' => '',
            ];
        }
    }

    // =====================================================================
    // WORLD MODE (Phase 1: presence only)
    // =====================================================================

    /** Handle a WS connection that joined a world (pixel map) instead of a room. */
    private function openWorld(ConnectionInterface $conn, string $worldId, string $deviceId, string $nickname, string $emoji): void
    {
        $summary = $this->roomManager->getRoomSummary($worldId);
        if (!$summary || ($summary['mode'] ?? 'legacy') !== 'world') {
            $conn->send(json_encode([
                'type' => 'world_not_found',
                'message' => 'World ini tidak ditemukan atau sudah kedaluwarsa.',
            ]));
            $conn->close();
            return;
        }

        if ($this->worldManager->isFull($worldId)) {
            $conn->send(json_encode([
                'type' => 'world_full',
                'message' => 'World sudah penuh (' . WorldManager::MAX_USERS_PER_WORLD . ' pemain). Coba world lain.',
            ]));
            $conn->close();
            return;
        }

        $resId = $conn->resourceId;
        $map = $this->worldManager->ensureMap($worldId);
        $spawn = $this->worldManager->spawnPointFor($map, $this->worldManager->count($worldId));

        $this->clientMeta[$resId] = [
            'mode' => 'world',
            'room_id' => $worldId,
            'device_id' => $deviceId,
            'nickname' => $nickname,
            'emoji' => $emoji,
        ];
        $this->worldConnections[$resId] = $conn;

        $this->worldManager->join($worldId, $resId, [
            'x' => $spawn['x'],
            'y' => $spawn['y'],
            'dir' => 0,
            'emoji' => $emoji,
            'nickname' => $nickname,
            'device_id' => $deviceId,
        ]);
        $this->worldManager->setWorldHost($worldId, (string)($summary['host_device_id'] ?? ''));

        // World rooms are created with empty_since = now and nothing else clears
        // it, so purgeInactiveRooms(600) used to delete a world (and its mats)
        // 10 minutes after creation even with players inside. Occupancy is
        // in-memory for worlds, so mark it here and in onClose.
        $this->roomManager->markEmptySince($worldId, false);

        $conn->send(json_encode([
            'type' => 'world_init',
            'world_id' => $worldId,
            'name' => $summary['name'] ?? 'Jamming World',
            'map' => $map,
            'you' => ['id' => $resId, 'x' => $spawn['x'], 'y' => $spawn['y'], 'emoji' => $emoji, 'nickname' => $nickname,
                      'is_owner' => ((string)($summary['host_device_id'] ?? '') === $deviceId)],
            'avatars' => $this->worldManager->snapshot($worldId),
            'boxes' => $this->worldManager->boxesPayload($worldId),
            'online' => $this->worldManager->count($worldId),
            'max_users' => WorldManager::MAX_USERS_PER_WORLD,
            'server_time' => (int)(microtime(true) * 1000),
        ]));
    }

    /** Route world-protocol messages (movement + mats + zone selection). */
    /**
     * Entry point for world messages.
     *
     * The world branch in onMessage() runs BEFORE its try/catch, so any
     * exception here (DB error, FK violation, bad payload) propagated into
     * Ratchet and closed the whole connection — "gelar tikar" silently dropped
     * the player. Every world action is now contained: the failure is logged and
     * the client gets a notice instead of a disconnect.
     */
    private function handleWorldMessage(ConnectionInterface $from, array $meta, string $type, array $data): void
    {
        try {
            $this->dispatchWorldMessage($from, $meta, $type, $data);
        } catch (\Throwable $e) {
            error_log('[WebSocket world error] ' . $type . ': ' . $e->getMessage());
            try {
                $from->send(json_encode([
                    'type' => 'notice',
                    'message' => 'Aksi world gagal diproses. Coba lagi sebentar.',
                    'level' => 'warning',
                ]));
            } catch (\Throwable $ignored) {
                // Connection already gone; nothing left to notify.
            }
        }
    }

    private function dispatchWorldMessage(ConnectionInterface $from, array $meta, string $type, array $data): void
    {
        $worldId = $meta['room_id'];
        $resId = $from->resourceId;

        switch ($type) {
            case 'world.move':
                // Movement is high-frequency: separate, generous limit.
                if (!$this->rateLimiter->allow(RateLimiter::key('world_move', $meta['device_id']), 90, 3)) {
                    break;
                }
                $map = $this->worldManager->getMap($worldId);
                $x = Validator::position($data['x'] ?? 0);
                $y = Validator::position($data['y'] ?? 0);
                $dir = max(0, min(3, (int)($data['dir'] ?? 0)));
                if ($this->worldManager->move($worldId, $resId, $map, $x, $y)) {
                    if (isset($this->clientMeta[$resId])) {
                        $this->clientMeta[$resId]['dir'] = $dir;
                    }
                }
                break;

            case 'zone.select':
                // User answered the overlap dialog. Verify they are actually
                // inside the chosen mat's radius (anti-spoof).
                $boxId = is_string($data['box_id'] ?? null) ? $data['box_id'] : '';
                $me = $this->worldManager->getAvatar($worldId, $resId);
                if ($me === null || $boxId === '') {
                    break;
                }
                $box = $this->worldManager->getBox($worldId, $boxId);
                if ($box === null) {
                    break;
                }
                if (hypot($me['x'] - $box['x'], $me['y'] - $box['y']) > (float)$box['radius']) {
                    break;
                }
                unset($this->pendingChoice[$worldId][$resId]);
                $this->applyZone($from, $worldId, $resId, $box, true);
                break;

            case 'mat.place':
                if (!$this->rateLimiter->allow(RateLimiter::key('mat_place', $meta['device_id']), 5, 60)) {
                    break;
                }
                $me = $this->worldManager->getAvatar($worldId, $resId);
                if ($me === null) {
                    break;
                }
                $label = Validator::clean($data['label'] ?? ($meta['nickname'] . "'s Tikar"), 40);
                $control = in_array($data['control_mode'] ?? '', ['owner', 'everyone'], true) ? $data['control_mode'] : 'everyone';
                $box = $this->worldManager->placeBox(
                    $worldId,
                    $meta['device_id'],
                    $meta['nickname'],
                    (float)$me['x'],
                    (float)$me['y'],
                    $label,
                    $control
                );
                if ($box === null) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => 'Tidak bisa gelar tikar di sini (nabrak tembok, terlalu dekat tikar lain, atau world penuh).',
                        'level' => 'warning',
                    ]));
                    break;
                }
                $this->broadcastWorld($worldId, [
                    'type' => 'mat.placed',
                    'box' => $this->boxPublicPayload($box, $worldId),
                ]);
                // Placer immediately joins their own mat.
                $this->applyZone($from, $worldId, $resId, $box, true);
                break;

            case 'mat.pickup':
                $boxId = is_string($data['box_id'] ?? null) ? $data['box_id'] : '';
                $box = $boxId !== '' ? $this->worldManager->getBox($worldId, $boxId) : null;
                if ($box === null || $box['owner_device_id'] !== $meta['device_id']) {
                    $from->send(json_encode([
                        'type' => 'notice',
                        'message' => 'Hanya pemilik tikar yang bisa mengangkatnya.',
                        'level' => 'warning',
                    ]));
                    break;
                }
                // Anyone currently on this mat must be detached first.
                foreach ($this->clientMeta as $rid => $cm) {
                    if (($cm['mode'] ?? '') === 'world' && $cm['room_id'] === $worldId
                        && $this->worldManager->getActiveBox($worldId, $rid) === $boxId) {
                        $conn = $this->findConnection($rid);
                        if ($conn !== null) {
                            $this->detachFromRoom($box['room_id'], $rid, $cm);
                            $conn->send(json_encode([
                                'type' => 'zone.exit',
                                'box_id' => $boxId,
                                'reason' => 'picked_up',
                            ]));
                        }
                        $this->worldManager->setActiveBox($worldId, $rid, null);
                    }
                }
                $this->worldManager->removeBox($worldId, $boxId);
                $this->broadcastWorld($worldId, [
                    'type' => 'mat.removed',
                    'box_id' => $boxId,
                ]);
                break;

            case 'world.chat':
                $text = Validator::chatMessage($data['message'] ?? '');
                if ($text === '' || !$this->rateLimiter->allow(RateLimiter::key('world_chat', $meta['device_id']), 6, 4)) {
                    break;
                }
                $this->broadcastWorld($worldId, [
                    'type' => 'world.chat',
                    'message' => [
                        'sender_nickname' => $meta['nickname'],
                        'sender_emoji' => $meta['emoji'],
                        'message' => $text,
                        'created_at' => date('Y-m-d H:i:s'),
                    ],
                ]);
                break;

            case 'world.emote':
                if (!$this->rateLimiter->allow(RateLimiter::key('world_emote', $meta['device_id']), 8, 4)) {
                    break;
                }
                $this->broadcastWorld($worldId, [
                    'type' => 'world.emote',
                    'id' => $resId,
                    'emote' => Validator::emoji($data['emote'] ?? ''),
                ]);
                break;

            case 'ping':
                // In world mode the ping doubles as the playback heartbeat for the
                // mat the player is standing on. Without track/state/position the
                // client had nothing to correct against, so a player who walked
                // into a mat mid-song never caught up with the others (legacy
                // rooms already answer ping with the full playback snapshot).
                $pong = [
                    'type' => 'pong',
                    'server_time' => (int)(microtime(true) * 1000),
                ];
                $activeBoxId = $this->worldManager->getActiveBox($worldId, $resId);
                $activeBox = $activeBoxId !== null ? $this->worldManager->getBox($worldId, $activeBoxId) : null;
                if ($activeBox !== null && isset($this->rooms[$activeBox['room_id']])) {
                    $matRoomId = $activeBox['room_id'];
                    $pong['box_id'] = $activeBox['id'];
                    $pong['room_id'] = $matRoomId;
                    $pong['position'] = $this->getCurrentPosition($matRoomId);
                    $pong['state'] = $this->rooms[$matRoomId]['playback_state'] ?? 'stopped';
                    $pong['track'] = $this->rooms[$matRoomId]['current_track'] ?? null;
                }
                $from->send(json_encode($pong));
                break;
        }
    }

    /** Broadcast the current mat list for a world (after a change). */
    private function broadcastWorldBoxes(string $worldId): void
    {
        $this->broadcastWorld($worldId, [
            'type' => 'world.boxes',
            'boxes' => $this->worldManager->boxesPayload($worldId),
        ]);
    }

    private function boxPublicPayload(array $box, string $worldId): array
    {
        return [
            'id' => $box['id'],
            'room_id' => $box['room_id'],
            'label' => $box['label'],
            'x' => (float)$box['x'],
            'y' => (float)$box['y'],
            'r' => (float)$box['radius'],
            'owner' => $box['owner_device_id'],
            'control' => $box['control_mode'],
            'users' => $this->worldManager->countInBox($worldId, (string)$box['id']),
        ];
    }

    /**
     * Switch a world client's active mat: detach from the previous room, attach
     * to the new one, and tell the client which room it is now listening to.
     */
    private function applyZone(ConnectionInterface $conn, string $worldId, int $resId, array $box, bool $explicit): void
    {
        $current = $this->worldManager->getActiveBox($worldId, $resId);
        if ($current === $box['id']) {
            return;
        }

        $meta = $this->clientMeta[$resId] ?? [];

        if ($current !== null) {
            $prev = $this->worldManager->getBox($worldId, $current);
            if ($prev !== null) {
                $this->detachFromRoom($prev['room_id'], $resId, $meta);
                // If nobody remains attached, start the empty timer.
                if ($this->worldManager->activeUsersInBox($worldId, $current) <= 1) {
                    $this->worldManager->markBoxEmpty($current, true);
                }
            }
            $conn->send(json_encode([
                'type' => 'zone.exit',
                'box_id' => $current,
            ]));
        }

        unset($this->pendingChoice[$worldId][$resId]);
        $this->worldManager->setActiveBox($worldId, $resId, $box['id']);
        $this->worldManager->markBoxEmpty($box['id'], false);
        $this->attachToRoom($conn, $box['room_id']);
        $conn->send(json_encode([
            'type' => 'zone.enter',
            'box_id' => $box['id'],
            'room_id' => $box['room_id'],
            'label' => $box['label'],
            'control' => $box['control_mode'],
        ]));

        $this->broadcastWorldBoxes($worldId);
    }

    /**
     * Broadcast a single compact snapshot of every world to all their clients.
     * Called on a 15 Hz timer from the daemon.
     */
    public function tickWorlds(): void
    {
        foreach ($this->worldManager->allWorldIds() as $worldId) {
            // One failing world (DB hiccup, bad box row) must not stop the tick
            // for every other world — or kill the periodic timer entirely.
            try {
                $this->tickWorld($worldId);
            } catch (\Throwable $e) {
                error_log('[WebSocket world tick] ' . $worldId . ': ' . $e->getMessage());
            }
        }

        // Occasional mat maintenance (roughly every 2 seconds at 15 Hz).
        if ((++$this->worldTickCounter % 30) === 0) {
            try {
                $this->maintainMats();
            } catch (\Throwable $e) {
                error_log('[WebSocket mat maintenance] ' . $e->getMessage());
            }
        }
    }

    private function tickWorld(string $worldId): void
    {
        // Resolve automatic zone membership from server-authoritative positions.
        $this->resolveZones($worldId);

        $avatars = $this->worldManager->snapshot($worldId);
        $payload = json_encode([
            'type' => 'world.snapshot',
            't' => (int)(microtime(true) * 1000),
            'avatars' => $avatars,
        ]);

        foreach ($this->clientMeta as $resId => $meta) {
            if (($meta['mode'] ?? 'room') !== 'world' || $meta['room_id'] !== $worldId) {
                continue;
            }
            $conn = $this->findConnection($resId);
            if ($conn !== null) {
                try {
                    $conn->send($payload);
                } catch (\Throwable $e) {
                    // Connection dropped mid-broadcast; ignore.
                }
            }
        }
    }

    /**
     * Recycle mats that have been empty for a while. Runs on the world tick so
     * abandoned mats (and their audio rooms) do not pile up.
     */
    private function maintainMats(): void
    {
        foreach ($this->worldManager->allWorldIds() as $worldId) {
            $removed = $this->worldManager->purgeEmptyBoxes($worldId, 120);
            foreach ($removed as $boxId) {
                $this->broadcastWorld($worldId, [
                    'type' => 'mat.removed',
                    'box_id' => $boxId,
                    'reason' => 'expired',
                ]);
            }
        }
    }

    /**
     * Automatic mat membership each tick:
     *  - 0 mats in range  -> leave current mat (zone.exit)
     *  - 1 mat in range   -> auto-enter
     *  - 2+ mats in range -> ask the client to choose (zone.choice_required)
     * Server decides everything; the client only answers the choice.
     */
    private function resolveZones(string $worldId): void
    {
        foreach (array_keys($this->worldManager->avatarsByResId($worldId)) as $resId) {
            $meta = $this->clientMeta[$resId] ?? null;
            if ($meta === null || ($meta['mode'] ?? '') !== 'world' || $meta['room_id'] !== $worldId) {
                continue;
            }
            $avatar = $this->worldManager->getAvatar($worldId, $resId);
            if ($avatar === null) {
                continue;
            }

            $hits = $this->worldManager->boxesContaining($worldId, (float)$avatar['x'], (float)$avatar['y']);
            $conn = $this->findConnection($resId);
            if ($conn === null) {
                continue;
            }

            $current = $this->worldManager->getActiveBox($worldId, $resId);

            if (count($hits) === 0) {
                unset($this->pendingChoice[$worldId][$resId]);
                if ($current !== null) {
                    $prev = $this->worldManager->getBox($worldId, $current);
                    if ($prev !== null) {
                        $this->detachFromRoom($prev['room_id'], $resId, $meta);
                        if ($this->worldManager->activeUsersInBox($worldId, $current) <= 1) {
                            $this->worldManager->markBoxEmpty($current, true);
                        }
                    }
                    $this->worldManager->setActiveBox($worldId, $resId, null);
                    $conn->send(json_encode(['type' => 'zone.exit', 'box_id' => $current]));
                    $this->broadcastWorldBoxes($worldId);
                }
                continue;
            }

            if (count($hits) === 1) {
                unset($this->pendingChoice[$worldId][$resId]);
                if ($current !== $hits[0]['id']) {
                    $this->applyZone($conn, $worldId, $resId, $hits[0], false);
                }
                continue;
            }

            // 2+ mats: if the user is already on one of them, stay put; otherwise
            // ask which mat they want to join.
            $ids = array_column($hits, 'id');
            if ($current !== null && in_array($current, $ids, true)) {
                continue;
            }

            // Ask only once: resolveZones runs at 15 Hz, so re-sending every tick
            // spammed the dialog and made it impossible to answer.
            if (isset($this->pendingChoice[$worldId][$resId])) {
                continue;
            }
            $this->pendingChoice[$worldId][$resId] = true;

            $choices = [];
            foreach ($hits as $b) {
                $choices[] = [
                    'id' => $b['id'],
                    'label' => $b['label'],
                    'owner' => $b['owner_device_id'],
                    'users' => $this->worldManager->countInBox($worldId, (string)$b['id']),
                ];
            }
            $conn->send(json_encode([
                'type' => 'zone.choice_required',
                'boxes' => $choices,
            ]));
        }
    }

    /** Resolve a live connection by resource id (world clients are not in $rooms). */
    private function findConnection(int $resId): ?ConnectionInterface
    {
        if (isset($this->worldConnections[$resId])) {
            return $this->worldConnections[$resId];
        }
        foreach ($this->rooms as $room) {
            if (isset($room['clients'][$resId])) {
                return $room['clients'][$resId];
            }
        }
        return null;
    }

    private function broadcastWorld(string $worldId, array $payload): void
    {
        $json = json_encode($payload);
        foreach ($this->clientMeta as $resId => $meta) {
            if (($meta['mode'] ?? 'room') !== 'world' || $meta['room_id'] !== $worldId) {
                continue;
            }
            $conn = $this->findConnection($resId);
            if ($conn !== null) {
                try {
                    $conn->send($json);
                } catch (\Throwable $e) {
                }
            }
        }
    }
}
