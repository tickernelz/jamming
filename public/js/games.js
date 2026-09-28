/**
 * games.js
 * Real-time mini games (Adu Dadu, Adu Angka, Roulette Spin) for Jamri Jamming Rooms
 * Synchronized live across room members with cooldown enforcement and accumulated penalties.
 */

class JamriGames {
    constructor() {
        this.roomId = null;
        this.user = null;
        this.ws = null;
        this.audioCtx = null;
        this.selectedGame = 'dice';
        this.penaltyMinutes = 2;
        this.activePunishments = [];
        this.myPunishment = null;
        this.punishmentTimer = null;
        this.cooldownUntil = 0;
        this.cooldownTimer = null;
        this.arenaActive = false;

        this.initAudioContext();
    }

    initAudioContext() {
        try {
            const AudioClass = window.AudioContext || window.webkitAudioContext;
            if (AudioClass) {
                this.audioCtx = new AudioClass();
            }
        } catch (e) {
            console.warn('[Games] Web Audio not supported:', e);
        }
    }

    ensureAudio() {
        if (!this.audioCtx) this.initAudioContext();
        if (this.audioCtx && this.audioCtx.state === 'suspended') {
            this.audioCtx.resume().catch(() => {});
        }
    }

    playTickSound() {
        if (!this.audioCtx) return;
        try {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800 + Math.random() * 200, this.audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(200, this.audioCtx.currentTime + 0.04);
            gain.gain.setValueAtTime(0.15, this.audioCtx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + 0.04);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start();
            osc.stop(this.audioCtx.currentTime + 0.04);
        } catch (e) {}
    }

    playDiceShakeSound() {
        if (!this.audioCtx) return;
        try {
            const bufferSize = this.audioCtx.sampleRate * 0.12;
            const buffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.4));
            }
            const noise = this.audioCtx.createBufferSource();
            noise.buffer = buffer;
            const filter = this.audioCtx.createBiquadFilter();
            filter.type = 'bandpass';
            filter.frequency.value = 1400;
            const gain = this.audioCtx.createGain();
            gain.gain.value = 0.2;
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(this.audioCtx.destination);
            noise.start();
        } catch (e) {}
    }

    playLoserBuzzer() {
        if (!this.audioCtx) return;
        try {
            const now = this.audioCtx.currentTime;
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sawtooth';
            osc.frequency.setValueAtTime(220, now);
            osc.frequency.linearRampToValueAtTime(140, now + 0.35);
            osc.frequency.linearRampToValueAtTime(90, now + 0.7);
            gain.gain.setValueAtTime(0.2, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
            osc.connect(gain);
            gain.connect(this.audioCtx.destination);
            osc.start(now);
            osc.stop(now + 0.7);
        } catch (e) {}
    }

    playFanfare() {
        if (!this.audioCtx) return;
        try {
            const notes = [523.25, 659.25, 783.99, 1046.50];
            notes.forEach((freq, i) => {
                const now = this.audioCtx.currentTime + i * 0.1;
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.15, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
                osc.connect(gain);
                gain.connect(this.audioCtx.destination);
                osc.start(now);
                osc.stop(now + 0.3);
            });
        } catch (e) {}
    }

    attach(roomId, user, ws) {
        this.roomId = roomId;
        this.user = user;
        this.ws = ws;

        this.setupWebSocket();
    }

    setupWebSocket() {
        if (!this.ws) return;

        this.ws.on('game_started', (data) => {
            if (data.cooldown_until) {
                this.setCooldown(data.cooldown_until);
            }
            this.openGameArena(data);
        });

        this.ws.on('punishments_updated', (data) => {
            if (data.cooldown_until) {
                this.setCooldown(data.cooldown_until);
            }
            this.setPunishments(data.punishments || []);
        });

        this.ws.on('game_cooldown_active', (data) => {
            if (data.cooldown_until) {
                this.setCooldown(data.cooldown_until);
            }
            if (window.showToast) {
                window.showToast(data.message || 'Game sedang dalam masa jeda (cooldown).', 'warning');
            }
        });
    }

    setPunishments(list) {
        this.activePunishments = list || [];
        const myDevId = this.user ? this.user.device_id : '';
        const myNick = this.user ? this.user.nickname : '';
        
        const now = Math.floor(Date.now() / 1000);
        // Sort matching active punishments descending by until timestamp to pick maximum expiry
        const matching = this.activePunishments.filter(p => 
            (p.device_id === myDevId || p.nickname === myNick) && p.until > now
        );
        matching.sort((a, b) => b.until - a.until);
        this.myPunishment = matching[0] || null;

        // Reset timer interval cleanly to avoid freezing or sticking
        if (this.punishmentTimer) {
            clearInterval(this.punishmentTimer);
            this.punishmentTimer = null;
        }

        this.updatePunishmentBanner();
        this.renderActivePunishmentsWidget();

        if (window.JAMRI_APP && window.JAMRI_APP.currentChat) {
            window.JAMRI_APP.currentChat.setPunishments(this.activePunishments);
        }
    }

    isPunished() {
        if (!this.myPunishment) return false;
        const now = Math.floor(Date.now() / 1000);
        return this.myPunishment.until > now;
    }

    getPunishmentRemainingSeconds() {
        if (!this.myPunishment) return 0;
        const now = Math.floor(Date.now() / 1000);
        return Math.max(0, this.myPunishment.until - now);
    }

    notifyPunishedAction(actionName = 'mengubah musik') {
        const sec = this.getPunishmentRemainingSeconds();
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const message = `Kontrol dinonaktifkan: Anda sedang dalam masa sanksi game (sisa ${timeStr}).`;
        if (window.showToast) {
            window.showToast(message, 'warning');
        }
    }

    setCooldown(untilTimestamp) {
        this.cooldownUntil = untilTimestamp || 0;
        this.updateCooldownState();
    }

    updateCooldownState() {
        const btnStart = document.getElementById('btn-start-mini-game');
        if (!btnStart) return;

        const now = Math.floor(Date.now() / 1000);
        const remaining = Math.max(0, this.cooldownUntil - now);

        if (remaining > 0) {
            btnStart.disabled = true;
            btnStart.style.opacity = '0.6';
            btnStart.style.cursor = 'not-allowed';
            btnStart.innerHTML = `
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <polyline points="12 6 12 12 16 14"></polyline>
                </svg>
                <span>Jeda Game (${remaining}s)</span>
            `;

            if (!this.cooldownTimer) {
                this.cooldownTimer = setInterval(() => {
                    this.updateCooldownState();
                }, 1000);
            }
        } else {
            if (this.cooldownTimer) {
                clearInterval(this.cooldownTimer);
                this.cooldownTimer = null;
            }
            btnStart.disabled = false;
            btnStart.style.opacity = '1';
            btnStart.style.cursor = 'pointer';
            btnStart.innerHTML = `
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                    <polygon points="5 3 19 12 5 21 5 3"></polygon>
                </svg>
                <span>Mulai Game</span>
            `;
        }
    }

    updatePunishmentBanner() {
        let banner = document.getElementById('room-punishment-banner');
        if (!this.isPunished()) {
            if (banner) banner.style.display = 'none';
            if (this.punishmentTimer) {
                clearInterval(this.punishmentTimer);
                this.punishmentTimer = null;
            }
            return;
        }

        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'room-punishment-banner';
            banner.className = 'room-penalty-banner';
            const mainLayout = document.querySelector('.room-main-layout');
            if (mainLayout && mainLayout.parentNode) {
                mainLayout.parentNode.insertBefore(banner, mainLayout);
            } else {
                document.body.appendChild(banner);
            }
        }

        banner.style.display = 'flex';
        this.renderBannerContent(banner);

        if (!this.punishmentTimer) {
            this.punishmentTimer = setInterval(() => {
                if (!this.isPunished()) {
                    banner.style.display = 'none';
                    clearInterval(this.punishmentTimer);
                    this.punishmentTimer = null;
                    if (window.JAMRI_APP && window.JAMRI_APP.currentChat) {
                        window.JAMRI_APP.currentChat.appendActivityNotice('Masa sanksi telah berakhir. Kontrol musik kembali aktif.', '', 'Sistem');
                    }
                    if (window.showToast) {
                        window.showToast('Masa sanksi berakhir. Kontrol musik aktif kembali.', 'success');
                    }
                    return;
                }
                this.renderBannerContent(banner);
            }, 1000);
        }
    }

    renderBannerContent(banner) {
        const sec = this.getPunishmentRemainingSeconds();
        const m = Math.floor(sec / 60);
        const s = sec % 60;
        const timerStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
        const gameName = this.myPunishment ? this.myPunishment.game_name : 'Mini Game';

        banner.innerHTML = `
            <div class="penalty-banner-content" style="display:flex; align-items:center; justify-content:space-between; width:100%; gap:12px;">
                <div style="display:flex; align-items:center; gap:10px;">
                    <div style="width:32px; height:32px; border-radius:var(--radius-sm); background:var(--bg-surface); border:1px solid var(--danger); display:flex; align-items:center; justify-content:center; color:var(--danger); flex-shrink:0;">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
                            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
                        </svg>
                    </div>
                    <div>
                        <div style="font-size:13px; font-weight:700; color:var(--danger);">Kontrol Musik Terkunci (${this.escape(gameName)})</div>
                        <div style="font-size:12px; color:var(--text-secondary);">Play, pause, skip, dan antrean lagu dinonaktifkan sementara.</div>
                    </div>
                </div>
                <div class="penalty-countdown-badge" style="display:flex; align-items:center; gap:6px; background:var(--bg-surface); border:1px solid var(--danger); border-radius:var(--radius-full); padding:4px 10px; font-size:12px; font-weight:700; color:var(--danger); flex-shrink:0;">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    <span>${timerStr}</span>
                </div>
            </div>
        `;
    }

    renderPanel(container) {
        if (!container) return;

        container.innerHTML = `
            <div class="games-panel-wrapper">
                <div class="games-panel-header">
                    <div class="games-header-info">
                        <h2 class="games-header-title">Mini Game</h2>
                        <p class="games-header-sub">Tantang peserta room dalam 1 ronde. Peserta yang kalah dinonaktifkan kontrol musiknya sementara waktu.</p>
                    </div>
                </div>

                <div class="game-cards-selector">
                    <div class="game-select-card ${this.selectedGame === 'dice' ? 'selected' : ''}" data-game="dice">
                        <div class="game-card-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"></circle>
                                <circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"></circle>
                            </svg>
                        </div>
                        <h3 class="game-card-title">Adu Dadu</h3>
                        <p class="game-card-desc">Setiap peserta mengocok 2 dadu. Skor terkecil mendapat sanksi kontrol.</p>
                    </div>
                    <div class="game-select-card ${this.selectedGame === 'number' ? 'selected' : ''}" data-game="number">
                        <div class="game-card-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="4" y1="9" x2="20" y2="9"></line>
                                <line x1="4" y1="15" x2="20" y2="15"></line>
                                <line x1="10" y1="3" x2="8" y2="21"></line>
                                <line x1="16" y1="3" x2="14" y2="21"></line>
                            </svg>
                        </div>
                        <h3 class="game-card-title">Adu Angka</h3>
                        <p class="game-card-desc">Angka acak 1–100 per peserta. Angka terendah terkena sanksi.</p>
                    </div>
                    <div class="game-select-card ${this.selectedGame === 'wheel' ? 'selected' : ''}" data-game="wheel">
                        <div class="game-card-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"></circle>
                                <polyline points="12 6 12 12 16 14"></polyline>
                            </svg>
                        </div>
                        <h3 class="game-card-title">Roulette Spin</h3>
                        <p class="game-card-desc">Roda keberuntungan berputar live ke seluruh peserta room.</p>
                    </div>
                </div>

                <div class="game-settings-bar">
                    <div class="penalty-setting-group">
                        <label class="penalty-setting-label">Durasi Sanksi Kontrol Musik:</label>
                        <div class="penalty-duration-btns">
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 1 ? 'active' : ''}" data-min="1">1 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 2 ? 'active' : ''}" data-min="2">2 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 3 ? 'active' : ''}" data-min="3">3 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 5 ? 'active' : ''}" data-min="5">5 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 10 ? 'active' : ''}" data-min="10">10 Menit</button>
                        </div>
                    </div>

                    <button type="button" id="btn-start-mini-game" class="btn btn-primary btn-start-game-cta">
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        <span>Mulai Game</span>
                    </button>
                </div>

                <div class="active-punishments-section" id="active-punishments-box"></div>
            </div>
        `;

        // Card Selection
        const cards = container.querySelectorAll('.game-select-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                cards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.selectedGame = card.dataset.game;
            });
        });

        // Penalty Duration
        const durBtns = container.querySelectorAll('.btn-penalty-opt');
        durBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                durBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.penaltyMinutes = parseInt(btn.dataset.min, 10) || 2;
            });
        });

        // Start Game
        const btnStart = container.querySelector('#btn-start-mini-game');
        if (btnStart) {
            btnStart.addEventListener('click', () => {
                this.ensureAudio();
                const ws = this.ws || (window.JAMRI_APP && window.JAMRI_APP.wsClient);
                if (!ws || !ws.isConnected) {
                    if (window.showToast) {
                        window.showToast('Koneksi room belum terhubung.', 'warning');
                    }
                    return;
                }

                const now = Math.floor(Date.now() / 1000);
                if (this.cooldownUntil > now) {
                    const rem = this.cooldownUntil - now;
                    if (window.showToast) {
                        window.showToast(`Tunggu jeda ${rem} detik sebelum memulai game berikutnya.`, 'warning');
                    }
                    return;
                }

                btnStart.disabled = true;
                btnStart.innerHTML = `<span>Memulai...</span>`;

                setTimeout(() => {
                    this.updateCooldownState();
                }, 2000);

                ws.sendGameStart(this.selectedGame, this.penaltyMinutes);
            });
        }

        this.updateCooldownState();
        this.renderActivePunishmentsWidget();
    }

    renderActivePunishmentsWidget() {
        const box = document.getElementById('active-punishments-box');
        if (!box) return;

        const now = Math.floor(Date.now() / 1000);
        const active = (this.activePunishments || []).filter(p => p.until > now);

        if (active.length === 0) {
            box.innerHTML = `
                <div class="empty-punish-box" style="padding:14px; text-align:center; font-size:12px; color:var(--text-muted, #71717a);">
                    Tidak ada peserta yang sedang dalam masa sanksi.
                </div>
            `;
            return;
        }

        const isHost = window.JAMRI_USER && window.JAMRI_USER.is_host;

        box.innerHTML = `
            <div class="active-punish-header" style="margin-bottom:8px;">
                <span class="punish-heading" style="font-size:12px; font-weight:600; color:var(--text-muted, #a1a1aa);">Peserta Dalam Masa Sanksi (${active.length}):</span>
            </div>
            <div class="punish-users-cards">
                ${active.map(p => {
                    const sec = Math.max(0, p.until - now);
                    const m = Math.floor(sec / 60);
                    const s = sec % 60;
                    const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    return `
                        <div class="punish-user-item" style="display:flex; align-items:center; justify-content:space-between; padding:8px 10px; margin-bottom:6px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.06); border-radius:8px;">
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span class="p-avatar" style="width:26px; height:26px; border-radius:50%; background:rgba(255,255,255,0.08); display:flex; align-items:center; justify-content:center; font-size:13px;">${this.safeEmoji(p.emoji)}</span>
                                <div>
                                    <span class="p-nick" style="font-size:13px; font-weight:500; color:var(--text-main);">${this.escape(p.nickname)}</span>
                                    <span style="font-size:11px; color:var(--text-muted); margin-left:6px;">(${this.escape(p.game_name || 'Game')})</span>
                                </div>
                            </div>
                            <div style="display:flex; align-items:center; gap:8px;">
                                <span class="p-timer" style="font-size:12px; font-weight:600; color:#ef4444;">${timeStr}</span>
                                ${isHost ? `
                                    <button type="button" class="btn btn-ghost btn-xs btn-clear-punish" data-devid="${p.device_id}" style="font-size:11px; padding:2px 6px;">
                                        Ampuni
                                    </button>
                                ` : ''}
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;

        if (isHost) {
            box.querySelectorAll('.btn-clear-punish').forEach(btn => {
                btn.addEventListener('click', () => {
                    const devId = btn.dataset.devid;
                    if (devId && this.ws) {
                        this.ws.sendPunishmentClear(devId);
                    }
                });
            });
        }
    }

    openGameArena(gameData) {
        this.ensureAudio();
        let modal = document.getElementById('jamri-game-arena-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'jamri-game-arena-modal';
            modal.className = 'game-arena-backdrop';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div class="game-arena-box">
                <div class="arena-header" style="display:flex; align-items:center; justify-content:space-between; padding:12px 18px; border-bottom:1px solid var(--border-subtle); background:var(--bg-surface-elevated);">
                    <div class="arena-title-area" style="display:flex; align-items:center; gap:8px;">
                        <span class="arena-game-badge" style="font-size:14px; font-weight:700; color:var(--text-primary);">${gameData.game_name}</span>
                        <span style="font-size:11px; font-weight:600; color:var(--danger); background:var(--danger-light); border:1px solid var(--danger); padding:2px 8px; border-radius:12px;">Sanksi: ${gameData.penalty_minutes} Menit</span>
                    </div>
                    <button type="button" class="btn-close-arena btn btn-ghost btn-icon btn-sm" title="Tutup">✕</button>
                </div>

                <div class="arena-body" id="arena-stage"></div>
                <div class="arena-footer" id="arena-result-bar" style="display:none;"></div>
            </div>
        `;

        modal.querySelector('.btn-close-arena').addEventListener('click', () => {
            modal.style.display = 'none';
            this.arenaActive = false;
        });

        modal.style.display = 'flex';
        this.arenaActive = true;

        const stage = modal.querySelector('#arena-stage');
        const resultBar = modal.querySelector('#arena-result-bar');

        if (gameData.game_type === 'dice') {
            this.runDiceArena(stage, resultBar, gameData);
        } else if (gameData.game_type === 'number') {
            this.runNumberArena(stage, resultBar, gameData);
        } else {
            this.runWheelArena(stage, resultBar, gameData);
        }
    }

    runDiceArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;

        stage.innerHTML = `
            <div class="dice-arena-grid">
                ${participants.map((p, idx) => {
                    const cardId = p.id || ('p_' + idx);
                    return `
                    <div class="dice-player-card" id="dice-card-${cardId}">
                        <div class="dice-p-avatar">${this.safeEmoji(p.emoji)}</div>
                        <div class="dice-p-name">${this.escape(p.nickname)}</div>
                        <div class="dice-cubes-row">
                            <div class="dice-box rolling d1">·</div>
                            <div class="dice-box rolling d2">·</div>
                        </div>
                        <div class="dice-total-score">Mengocok...</div>
                    </div>
                `}).join('')}
            </div>
        `;

        let rollInterval = setInterval(() => {
            this.playDiceShakeSound();
        }, 220);

        const faces = ['1', '2', '3', '4', '5', '6'];
        let faceInterval = setInterval(() => {
            stage.querySelectorAll('.dice-box').forEach(box => {
                box.textContent = faces[Math.floor(Math.random() * 6)];
            });
        }, 90);

        setTimeout(() => {
            clearInterval(rollInterval);
            clearInterval(faceInterval);

            participants.forEach((p, idx) => {
                const cardId = p.id || ('p_' + idx);
                const card = stage.querySelector(`#dice-card-${cardId}`);
                if (!card) return;

                const isLoser = loser && (loser.id ? loser.id === cardId : (loser.device_id === p.device_id && loser.nickname === p.nickname));
                const d1Box = card.querySelector('.d1');
                const d2Box = card.querySelector('.d2');
                const scoreText = card.querySelector('.dice-total-score');

                d1Box.classList.remove('rolling');
                d2Box.classList.remove('rolling');
                d1Box.textContent = String(p.die1 || 1);
                d2Box.textContent = String(p.die2 || 1);

                scoreText.innerHTML = `Total: <strong>${p.score}</strong> (${p.die1} + ${p.die2})`;

                if (isLoser) {
                    card.classList.add('is-loser');
                    const badge = document.createElement('div');
                    badge.className = 'loser-stamp';
                    badge.textContent = 'Kalah';
                    card.appendChild(badge);
                } else {
                    card.classList.add('is-safe');
                }
            });

            this.showResultSummary(resultBar, loser, gameData);
        }, 3200);
    }

    runNumberArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;

        stage.innerHTML = `
            <div class="number-arena-grid">
                ${participants.map((p, idx) => {
                    const cardId = p.id || ('p_' + idx);
                    return `
                    <div class="number-player-card" id="num-card-${cardId}">
                        <div class="num-p-avatar">${this.safeEmoji(p.emoji)}</div>
                        <div class="num-p-name">${this.escape(p.nickname)}</div>
                        <div class="num-digital-display">
                            <span class="digital-number rolling-number">--</span>
                        </div>
                        <div class="num-status-label">Mengacak angka...</div>
                    </div>
                `}).join('')}
            </div>
        `;

        let tickInterval = setInterval(() => {
            this.playTickSound();
        }, 120);

        let counterInterval = setInterval(() => {
            stage.querySelectorAll('.rolling-number').forEach(box => {
                box.textContent = String(Math.floor(Math.random() * 100) + 1).padStart(2, '0');
            });
        }, 70);

        setTimeout(() => {
            clearInterval(tickInterval);
            clearInterval(counterInterval);

            participants.forEach((p, idx) => {
                const cardId = p.id || ('p_' + idx);
                const card = stage.querySelector(`#num-card-${cardId}`);
                if (!card) return;

                const isLoser = loser && (loser.id ? loser.id === cardId : (loser.device_id === p.device_id && loser.nickname === p.nickname));
                const numEl = card.querySelector('.digital-number');
                const statusEl = card.querySelector('.num-status-label');

                numEl.classList.remove('rolling-number');
                numEl.textContent = String(p.score).padStart(2, '0');

                if (isLoser) {
                    card.classList.add('is-loser');
                    statusEl.innerHTML = '<span style="color:#ef4444; font-weight:600;">Terendah (Kalah)</span>';
                } else {
                    card.classList.add('is-safe');
                    statusEl.innerHTML = '<span style="color:#10b981; font-weight:500;">Aman</span>';
                }
            });

            this.showResultSummary(resultBar, loser, gameData);
        }, 3500);
    }

    runWheelArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;
        const landingDeg = gameData.landing_deg || 1800;

        stage.innerHTML = `
            <div class="wheel-arena-wrapper">
                <div class="wheel-pointer-arrow">
                    <svg width="24" height="28" viewBox="0 0 24 24" fill="#fbbf24">
                        <path d="M12 22l-10-18h20z"></path>
                    </svg>
                </div>
                <canvas id="roulette-canvas" width="460" height="460" class="wheel-canvas"></canvas>
                <div class="wheel-center-hub">🎯</div>
            </div>
        `;

        const canvas = stage.querySelector('#roulette-canvas');
        this.drawRouletteWheel(canvas, participants);

        const durationSec = 6.2;
        canvas.style.transition = `transform ${durationSec}s cubic-bezier(0.12, 0.8, 0.2, 1)`;
        
        let tickCount = 0;
        const tickTimer = setInterval(() => {
            tickCount++;
            this.playTickSound();
            if (tickCount > 40) clearInterval(tickTimer);
        }, 140);

        requestAnimationFrame(() => {
            canvas.style.transform = `rotate(${landingDeg}deg)`;
        });

        setTimeout(() => {
            clearInterval(tickTimer);
            this.showResultSummary(resultBar, loser, gameData);
        }, durationSec * 1000 + 300);
    }

    drawRouletteWheel(canvas, participants) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        const numSlices = Math.max(1, participants.length);
        const radius = canvas.width / 2;
        const sliceAngle = (2 * Math.PI) / numSlices;

        const palette = [
            '#ef4444', '#3b82f6', '#10b981', '#f59e0b',
            '#8b5cf6', '#ec4899', '#06b6d4', '#14b8a6',
            '#f97316', '#6366f1'
        ];

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        for (let i = 0; i < numSlices; i++) {
            const startAngle = i * sliceAngle;
            const endAngle = startAngle + sliceAngle;
            const color = palette[i % palette.length];

            ctx.beginPath();
            ctx.moveTo(radius, radius);
            ctx.arc(radius, radius, radius - 8, startAngle, endAngle);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();

            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.stroke();

            ctx.save();
            ctx.translate(radius, radius);
            ctx.rotate(startAngle + sliceAngle / 2);
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffffff';
            ctx.font = '500 14px sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 3;

            const p = participants[i];
            const label = p.nickname;
            ctx.fillText(label, radius - 24, 5);
            ctx.restore();
        }

        ctx.beginPath();
        ctx.arc(radius, radius, radius - 8, 0, 2 * Math.PI);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(255,255,255,0.3)';
        ctx.stroke();
    }

    showResultSummary(resultBar, loser, gameData) {
        if (!resultBar) return;
        resultBar.style.display = 'flex';

        const isMe = this.user && loser && loser.device_id === this.user.device_id;
        if (isMe) {
            this.playLoserBuzzer();
        } else {
            this.playFanfare();
        }

        resultBar.innerHTML = `
            <div class="result-summary-box ${isMe ? 'you-lost' : 'safe'}" style="text-align:center; padding:14px; width:100%;">
                <div class="result-headline" style="font-size:15px; font-weight:700; margin-bottom:4px;">
                    ${isMe 
                        ? 'Anda kalah di ronde ini.' 
                        : `Peserta kalah: <strong>${this.escape(loser ? loser.nickname : 'Peserta')}</strong>`
                    }
                </div>
                <div class="result-penalty-info" style="font-size:12px; color:var(--text-secondary); margin-bottom:12px;">
                    Kontrol musik dinonaktifkan selama <strong>${gameData.penalty_minutes} menit</strong>.
                </div>
                <button type="button" class="btn btn-primary btn-sm btn-dismiss-arena">Tutup Arena</button>
            </div>
        `;

        resultBar.querySelector('.btn-dismiss-arena').addEventListener('click', () => {
            const modal = document.getElementById('jamri-game-arena-modal');
            if (modal) modal.style.display = 'none';
        });

        if (window.JAMRI_APP && window.JAMRI_APP.currentChat && loser) {
            window.JAMRI_APP.currentChat.appendActivityNotice(
                `kalah di ${gameData.game_name}. Kontrol musik terkunci ${gameData.penalty_minutes} menit.`,
                '',
                loser.nickname
            );
        }
    }

    escape(str) {
        return (str || '').replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m]));
    }

    /**
     * Sanitise an avatar emoji received via WebSocket before innerHTML injection.
     * game_started payloads are broadcast by the room host, so they are untrusted.
     */
    safeEmoji(str) {
        if (typeof str !== 'string' || str.length === 0 || str.length > 8) return '🎧';
        if (/[<>&"'`\/\\{}()\[\]=;:]/.test(str)) return '🎧';
        return str;
    }
}

window.JamriGames = JamriGames;
