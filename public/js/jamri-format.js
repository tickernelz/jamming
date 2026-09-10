/**
 * jamri-format.js
 * Engine format kompresi & dekompresi file .jamri + IndexedDB Offline Storage
 * 100% Client-Side - Tidak ada file yang dikirim ke server.
 */

class JamriFormat {
    static MAGIC = new Uint8Array([0x4A, 0x41, 0x4D, 0x52, 0x49, 0x01]); // "JAMRI\x01"

    /**
     * Mengompresi metadata + binary audio ke format .jamri
     * @param {Object} metadata - info lagu (id, title, channel, duration, etc.)
     * @param {ArrayBuffer} audioBuffer - data binary stream audio
     * @returns {Promise<Blob>} File .jamri terkompresi
     */
    static async pack(metadata, audioBuffer) {
        const metaJson = JSON.stringify(metadata);
        const metaBytes = new TextEncoder().encode(metaJson);
        const metaLen = metaBytes.byteLength;

        // Struktur uncompressed:
        // [6 bytes Magic] [4 bytes MetaLen] [MetaBytes] [AudioBytes]
        const totalRawLength = 6 + 4 + metaLen + audioBuffer.byteLength;
        const rawBuffer = new Uint8Array(totalRawLength);

        // 1. Magic
        rawBuffer.set(this.MAGIC, 0);

        // 2. MetaLen (32-bit Big Endian)
        const view = new DataView(rawBuffer.buffer);
        view.setUint32(6, metaLen, false);

        // 3. MetaBytes
        rawBuffer.set(metaBytes, 10);

        // 4. AudioBytes
        rawBuffer.set(new Uint8Array(audioBuffer), 10 + metaLen);

        // Kompresi mendalam menggunakan browser native CompressionStream (gzip)
        if ('CompressionStream' in window) {
            const stream = new Response(rawBuffer).body.pipeThrough(new CompressionStream('gzip'));
            const compressedBlob = await new Response(stream).blob();
            return new Blob([compressedBlob], { type: 'application/octet-stream' });
        }

        // Fallback jika CompressionStream tidak didukung
        return new Blob([rawBuffer], { type: 'application/octet-stream' });
    }

    /**
     * Mendekompresi file .jamri dan mengekstrak metadata + audio Blob
     * @param {Blob|File} file
     * @returns {Promise<{ metadata: Object, audioBlob: Blob, rawBuffer: ArrayBuffer }>}
     */
    static async unpack(file) {
        let arrayBuffer;

        // Coba dekompresi gzip
        if ('DecompressionStream' in window) {
            try {
                const decompressedStream = file.stream().pipeThrough(new DecompressionStream('gzip'));
                arrayBuffer = await new Response(decompressedStream).arrayBuffer();
            } catch (e) {
                // Mungkin uncompressed fallback
                arrayBuffer = await file.arrayBuffer();
            }
        } else {
            arrayBuffer = await file.arrayBuffer();
        }

        const uint8 = new Uint8Array(arrayBuffer);

        // Verifikasi Magic Bytes "JAMRI\x01"
        for (let i = 0; i < 6; i++) {
            if (uint8[i] !== this.MAGIC[i]) {
                throw new Error('Invalid .jamri file format: Magic signature mismatch');
            }
        }

        const view = new DataView(arrayBuffer);
        const metaLen = view.getUint32(6, false);

        const metaBytes = uint8.slice(10, 10 + metaLen);
        const metaJson = new TextDecoder().decode(metaBytes);
        const metadata = JSON.parse(metaJson);

        const audioBytes = uint8.slice(10 + metaLen);
        const mime = metadata.mime || 'audio/mp4';
        const audioBlob = new Blob([audioBytes], { type: mime });

        return {
            metadata,
            audioBlob,
            blobUrl: URL.createObjectURL(audioBlob),
        };
    }
}

/**
 * IndexedDB Wrapper untuk offline caching file .jamri
 */
class JamriOfflineDB {
    static DB_NAME = 'jamri_offline_db';
    static STORE_NAME = 'cached_tracks';
    static DB_VERSION = 1;

    static async open() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.STORE_NAME)) {
                    db.createObjectStore(this.STORE_NAME, { keyPath: 'youtube_id' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    static async saveTrack(metadata, jamriBlob) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            const item = {
                youtube_id: metadata.youtube_id,
                title: metadata.title,
                channel: metadata.channel,
                duration: metadata.duration,
                duration_formatted: metadata.duration_formatted,
                thumbnail: metadata.thumbnail,
                saved_at: Date.now(),
                file_size: jamriBlob.size,
                blob: jamriBlob,
            };
            store.put(item);
            tx.oncomplete = () => resolve(item);
            tx.onerror = () => reject(tx.error);
        });
    }

    static async getAllTracks() {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
    }

    static async getTrack(youtubeId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readonly');
            const store = tx.objectStore(this.STORE_NAME);
            const req = store.get(youtubeId);
            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => reject(req.error);
        });
    }

    static async deleteTrack(youtubeId) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE_NAME, 'readwrite');
            const store = tx.objectStore(this.STORE_NAME);
            store.delete(youtubeId);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }
}

window.JamriFormat = JamriFormat;
window.JamriOfflineDB = JamriOfflineDB;
