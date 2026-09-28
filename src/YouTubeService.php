<?php
// src/YouTubeService.php
// 100% Pure PHP - No .exe or external binary needed! Compatible with shared hosting.

declare(strict_types=1);

namespace Jamri;

use PDO;

class YouTubeService
{
    private PDO $pdo;

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    /**
     * Search YouTube using official InnerTube Web endpoint in pure PHP
     */
    public function search(string $query, int $limit = 15): array
    {
        $query = trim($query);
        if ($query === '') {
            return [];
        }

        // Direct YouTube video URL or ID check
        if (preg_match('/(?:youtu\.be\/|v=|\/embed\/|\/v\/|shorts\/)([a-zA-Z0-9_-]{11})/', $query, $matches)) {
            $info = $this->getVideoInfo($matches[1]);
            return $info ? [$info] : [];
        }

        if (preg_match('/^[a-zA-Z0-9_-]{11}$/', $query)) {
            $info = $this->getVideoInfo($query);
            return $info ? [$info] : [];
        }

        $ch = curl_init('https://www.youtube.com/youtubei/v1/search');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 8);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]);
        // TLS verification is enforced. Without it, a MITM could inject crafted
        // titles/thumbnails that flow straight into the UI.
        $caBundle = $this->resolveCaBundle();
        if ($caBundle !== null) {
            curl_setopt($ch, CURLOPT_CAINFO, $caBundle);
        }
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

        $payload = json_encode([
            'context' => [
                'client' => [
                    'clientName' => 'WEB',
                    'clientVersion' => '2.20240101.00.00',
                    'hl' => 'id',
                    'gl' => 'ID'
                ]
            ],
            'query' => $query
        ]);

        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200 || !$response || strlen($response) > 4 * 1024 * 1024) {
            return [];
        }

        $data = json_decode($response, true);
        $contents = $data['contents']['twoColumnSearchResultsRenderer']['primaryContents']['sectionListRenderer']['contents'] ?? [];

        $results = [];
        foreach ($contents as $section) {
            $items = $section['itemSectionRenderer']['contents'] ?? [];
            foreach ($items as $item) {
                if (isset($item['videoRenderer'])) {
                    $v = $item['videoRenderer'];
                    $id = $v['videoId'] ?? '';
                    if (!$id) continue;

                    // Skip livestreams
                    if (!empty($v['badges'])) {
                        foreach ($v['badges'] as $b) {
                            if (isset($b['metadataBadgeRenderer']['style']) && $b['metadataBadgeRenderer']['style'] === 'BADGE_STYLE_TYPE_LIVE_NOW') {
                                continue 2;
                            }
                        }
                    }

                    $title = $v['title']['runs'][0]['text'] ?? 'Untitled';
                    $channel = $v['ownerText']['runs'][0]['text'] ?? ($v['longBylineText']['runs'][0]['text'] ?? 'Unknown Artist');
                    $durationText = $v['lengthText']['simpleText'] ?? '';
                    $durationSec = $this->parseDurationText($durationText);

                    $thumbnail = "https://i.ytimg.com/vi/{$id}/mqdefault.jpg";
                    if (!empty($v['thumbnail']['thumbnails'])) {
                        $lastThumb = end($v['thumbnail']['thumbnails']);
                        if (!empty($lastThumb['url'])) {
                            $thumbnail = $lastThumb['url'];
                        }
                    }

                    $results[] = [
                        'youtube_id' => $id,
                        'title' => $title,
                        'channel' => $channel,
                        'duration' => $durationSec,
                        'duration_formatted' => $durationText ?: $this->formatSeconds($durationSec),
                        'thumbnail' => $thumbnail,
                    ];

                    if (count($results) >= $limit) {
                        break 2;
                    }
                }
            }
        }

        return $results;
    }

    /**
     * Fetch tracks from a public YouTube playlist using the InnerTube browse
     * endpoint. Returns [] when the playlist is empty/private or on any error.
     */
    public function getPlaylistItems(string $playlistId, int $limit = 50): array
    {
        $playlistId = Validator::playlistId($playlistId);
        if ($playlistId === '') {
            return [];
        }
        $limit = max(1, min($limit, 150));

        $ch = curl_init('https://www.youtube.com/youtubei/v1/browse');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 4);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
        curl_setopt($ch, CURLOPT_HTTPHEADER, [
            'Content-Type: application/json',
            'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        ]);
        $caBundle = $this->resolveCaBundle();
        if ($caBundle !== null) {
            curl_setopt($ch, CURLOPT_CAINFO, $caBundle);
        }
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);

        $payload = json_encode([
            'context' => [
                'client' => [
                    'clientName' => 'WEB',
                    'clientVersion' => '2.20240101.00.00',
                    'hl' => 'id',
                    'gl' => 'ID'
                ]
            ],
            'browseId' => 'VL' . $playlistId
        ]);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);

        $response = curl_exec($ch);
        $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpCode !== 200 || !$response || strlen($response) > 6 * 1024 * 1024) {
            return [];
        }

        $data = json_decode($response, true);
        if (!is_array($data)) {
            return [];
        }

        $contents = $data['contents']['twoColumnBrowseResultsRenderer']['tabs'][0]
            ['tabRenderer']['content']['sectionListRenderer']['contents'][0]
            ['itemSectionRenderer']['contents'][0]
            ['playlistVideoListRenderer']['contents'] ?? [];

        $results = [];
        foreach ($contents as $item) {
            if (!isset($item['playlistVideoRenderer'])) {
                continue;
            }
            $v = $item['playlistVideoRenderer'];
            $id = $v['videoId'] ?? '';
            if (!preg_match('/^[A-Za-z0-9_-]{11}$/', (string)$id)) {
                continue;
            }
            // Skip unavailable / deleted videos.
            $titleText = $v['title']['runs'][0]['text'] ?? ($v['title']['simpleText'] ?? '');
            if ($titleText === '' || ($v['isPlayable'] ?? true) === false) {
                continue;
            }

            $durationText = $v['lengthText']['simpleText'] ?? '';
            $durationSec = $this->parseDurationText($durationText);

            $thumbnail = "https://i.ytimg.com/vi/{$id}/mqdefault.jpg";
            if (!empty($v['thumbnail']['thumbnails'])) {
                $lastThumb = end($v['thumbnail']['thumbnails']);
                if (!empty($lastThumb['url'])) {
                    $thumbnail = $lastThumb['url'];
                }
            }

            $results[] = [
                'youtube_id' => $id,
                'title' => $titleText !== '' ? $titleText : 'Untitled',
                'channel' => $v['index']['simpleText'] ?? 'YouTube',
                'duration' => $durationSec,
                'duration_formatted' => $durationText ?: $this->formatSeconds($durationSec),
                'thumbnail' => $thumbnail,
            ];

            if (count($results) >= $limit) {
                break;
            }
        }

        return $results;
    }

    /**
     * Get video metadata in pure PHP
     */
    public function getVideoInfo(string $videoId): ?array
    {
        $ch = curl_init('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' . urlencode($videoId) . '&format=json');
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 3);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_PROTOCOLS, CURLPROTO_HTTPS);
        curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0');
        $caBundle = $this->resolveCaBundle();
        if ($caBundle !== null) {
            curl_setopt($ch, CURLOPT_CAINFO, $caBundle);
        }
        curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
        curl_setopt($ch, CURLOPT_SSL_VERIFYHOST, 2);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code === 200 && $res && strlen($res) <= 1024 * 1024) {
            $data = json_decode($res, true);
            if ($data) {
                return [
                    'youtube_id' => $videoId,
                    'title' => $data['title'] ?? 'YouTube Track',
                    'channel' => $data['author_name'] ?? 'Artist',
                    'duration' => 0,
                    'duration_formatted' => '--:--',
                    'thumbnail' => "https://i.ytimg.com/vi/{$videoId}/mqdefault.jpg",
                ];
            }
        }

        return [
            'youtube_id' => $videoId,
            'title' => 'YouTube Track',
            'channel' => 'Artist',
            'duration' => 0,
            'duration_formatted' => '--:--',
            'thumbnail' => "https://i.ytimg.com/vi/{$videoId}/mqdefault.jpg",
        ];
    }

    private function parseDurationText(string $str): int
    {
        if (trim($str) === '') {
            return 0;
        }
        // Format mm:ss or hh:mm:ss or mm.ss — cap components to avoid overflow.
        $cleaned = str_replace('.', ':', trim($str));
        $parts = array_map('intval', explode(':', $cleaned));
        $parts = array_map(static fn($n) => max(0, min($n, 86400)), $parts);
        if (count($parts) === 3) {
            return min($parts[0] * 3600 + $parts[1] * 60 + $parts[2], 86400);
        }
        if (count($parts) === 2) {
            return min($parts[0] * 60 + $parts[1], 86400);
        }
        return (int)($parts[0] ?? 0);
    }

    /**
     * Locate a CA bundle so TLS verification works on Windows/XAMPP builds that
     * ship without a configured cafile.
     */
    private function resolveCaBundle(): ?string
    {
        $configured = ini_get('curl.cainfo');
        if (is_string($configured) && $configured !== '' && is_file($configured)) {
            return $configured;
        }
        foreach ([
            dirname(__DIR__) . '/config/cacert.pem',
            'C:/xampp/apache/bin/curl-ca-bundle.crt',
            'C:/xampp/php/extras/ssl/cacert.pem',
        ] as $candidate) {
            if (is_file($candidate)) {
                return $candidate;
            }
        }
        return null;
    }

    private function formatSeconds(int $sec): string
    {
        if ($sec <= 0) return '--:--';
        $h = intdiv($sec, 3600);
        $m = intdiv($sec % 3600, 60);
        $s = $sec % 60;
        if ($h > 0) {
            return sprintf('%d:%02d:%02d', $h, $m, $s);
        }
        return sprintf('%d:%02d', $m, $s);
    }
}
