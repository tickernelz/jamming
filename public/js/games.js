/**
 * games.js
 * Real-time mini games (Adu Dadu, Adu Angka, Roulette Spin Wheel) for Jamri Jamming Rooms
 * Synchronized live across all room members with music control penalty enforcement.
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

    // --- Sound Synthesis ---
    playTickSound() {
        if (!this.audioCtx) return;
        try {
            const osc = this.audioCtx.createOscillator();
            const gain = this.audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(800 + Math.random() * 200, this.audioCtx.currentTime);
            osc.frequency.exponentialRampToValueAtTime(200, this.audioCtx.currentTime + 0.04);
            gain.gain.setValueAtTime(0.2, this.audioCtx.currentTime);
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
            const bufferSize = this.audioCtx.sampleRate * 0.15;
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
            gain.gain.value = 0.25;
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
            gain.gain.setValueAtTime(0.25, now);
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
            const notes = [523.25, 659.25, 783.99, 1046.50]; // C E G C
            notes.forEach((freq, i) => {
                const now = this.audioCtx.currentTime + i * 0.1;
                const osc = this.audioCtx.createOscillator();
                const gain = this.audioCtx.createGain();
                osc.type = 'triangle';
                osc.frequency.value = freq;
                gain.gain.setValueAtTime(0.2, now);
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
            this.openGameArena(data);
        });

        this.ws.on('punishments_updated', (data) => {
            this.setPunishments(data.punishments || []);
        });

        this.ws.on('punishment_status', (data) => {
            if (data.punished && data.punishment) {
                this.myPunishment = data.punishment;
                this.updatePunishmentBanner();
            }
        });
    }

    setPunishments(list) {
        this.activePunishments = list || [];
        const myDevId = this.user ? this.user.device_id : '';
        const myNick = this.user ? this.user.nickname : '';
        
        const now = Math.floor(Date.now() / 1000);
        this.myPunishment = this.activePunishments.find(p => 
            (p.device_id === myDevId || p.nickname === myNick) && p.until > now
        ) || null;

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
                        window.JAMRI_APP.currentChat.appendActivityNotice('Hukuman Anda telah berakhir! Kontrol musik dipulihkan. 🎉', '🎉', 'Sistem');
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
            <div class="penalty-banner-content">
                <span class="penalty-icon">🚫</span>
                <div class="penalty-text-group">
                    <div class="penalty-title">Anda Sedang Dihukum! (Kalah di ${this.escape(gameName)})</div>
                    <div class="penalty-desc">Kontrol musik (play, pause, next, prev, antrean & playlist) terkunci sementara.</div>
                </div>
                <div class="penalty-countdown-badge">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <polyline points="12 6 12 12 16 14"></polyline>
                    </svg>
                    <span>${timerStr}</span>
                </div>
            </div>
        `;
    }

    // --- Render Panel Launcher (Tab Mini Games) ---
    renderPanel(container) {
        if (!container) return;

        container.innerHTML = `
            <div class="games-panel-wrapper">
                <div class="games-panel-header">
                    <div class="games-header-info">
                        <h2 class="games-header-title">Mini Games 1 Ronde 🎮</h2>
                        <p class="games-header-sub">Tantang semua peserta room! Yang kalah dihukum tidak bisa mengatur musik selama beberapa menit.</p>
                    </div>
                </div>

                <div class="game-cards-selector">
                    <div class="game-select-card ${this.selectedGame === 'dice' ? 'selected' : ''}" data-game="dice">
                        <div class="game-card-badge">Paling Populer</div>
                        <div class="game-card-emoji">🎲</div>
                        <h3 class="game-card-title">Adu Dadu</h3>
                        <p class="game-card-desc">Semua peserta mengocok 2 dadu. Siapa dapat skor terkecil, dia yang kena sanksi!</p>
                    </div>
                    <div class="game-select-card ${this.selectedGame === 'number' ? 'selected' : ''}" data-game="number">
                        <div class="game-card-badge">Seru & Cepat</div>
                        <div class="game-card-emoji">🎯</div>
                        <h3 class="game-card-title">Adu Angka</h3>
                        <p class="game-card-desc">Undian angka acak 1–100. Angka terendah otomatis jadi pecundang yang dihukum.</p>
                    </div>
                    <div class="game-select-card ${this.selectedGame === 'wheel' ? 'selected' : ''}" data-game="wheel">
                        <div class="game-card-badge">Penuh Ketegangan</div>
                        <div class="game-card-emoji">🎡</div>
                        <h3 class="game-card-title">Roulette Spin</h3>
                        <p class="game-card-desc">Roda keberuntungan berputar live! Jarum menunjuk ke peserta yang paling apes.</p>
                    </div>
                </div>

                <div class="game-settings-bar">
                    <div class="penalty-setting-group">
                        <label class="penalty-setting-label">Durasi Hukuman Tidak Bisa Atur Musik:</label>
                        <div class="penalty-duration-btns">
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 1 ? 'active' : ''}" data-min="1">1 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 2 ? 'active' : ''}" data-min="2">2 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 3 ? 'active' : ''}" data-min="3">3 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 5 ? 'active' : ''}" data-min="5">5 Menit</button>
                            <button type="button" class="btn-penalty-opt ${this.penaltyMinutes === 10 ? 'active' : ''}" data-min="10">10 Menit</button>
                        </div>
                    </div>

                    <button type="button" id="btn-start-mini-game" class="btn btn-primary btn-start-game-cta">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        <span>Mulai Game Sekarang (Realtime ke Semua)</span>
                    </button>
                </div>

                <div class="active-punishments-section" id="active-punishments-box"></div>
            </div>
        `;

        // Card Selection Listeners
        const cards = container.querySelectorAll('.game-select-card');
        cards.forEach(card => {
            card.addEventListener('click', () => {
                cards.forEach(c => c.classList.remove('selected'));
                card.classList.add('selected');
                this.selectedGame = card.dataset.game;
            });
        });

        // Penalty Duration Listeners
        const durBtns = container.querySelectorAll('.btn-penalty-opt');
        durBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                durBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                this.penaltyMinutes = parseInt(btn.dataset.min, 10) || 2;
            });
        });

        // Start Game Listener
        const btnStart = container.querySelector('#btn-start-mini-game');
        if (btnStart) {
            btnStart.addEventListener('click', () => {
                this.ensureAudio();
                if (this.ws) {
                    this.ws.sendGameStart(this.selectedGame, this.penaltyMinutes);
                }
            });
        }

        this.renderActivePunishmentsWidget();
    }

    renderActivePunishmentsWidget() {
        const box = document.getElementById('active-punishments-box');
        if (!box) return;

        const now = Math.floor(Date.now() / 1000);
        const active = (this.activePunishments || []).filter(p => p.until > now);

        if (active.length === 0) {
            box.innerHTML = `
                <div class="empty-punish-box">
                    <span style="font-size:20px;">🛡️</span>
                    <span>Saat ini tidak ada peserta yang sedang dihukum. Bebas jamming!</span>
                </div>
            `;
            return;
        }

        const isHost = window.JAMRI_USER && window.JAMRI_USER.is_host;

        box.innerHTML = `
            <div class="active-punish-header">
                <span class="punish-heading">Daftar Peserta Sedang Dihukum (${active.length}):</span>
            </div>
            <div class="punish-users-cards">
                ${active.map(p => {
                    const sec = Math.max(0, p.until - now);
                    const m = Math.floor(sec / 60);
                    const s = sec % 60;
                    const timeStr = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
                    return `
                        <div class="punish-user-item">
                            <span class="p-avatar">${p.emoji || '🎧'}</span>
                            <div class="p-info">
                                <span class="p-nick">${this.escape(p.nickname)}</span>
                                <span class="p-reason">Kalah di ${this.escape(p.game_name || 'Game')}</span>
                            </div>
                            <span class="p-timer">⏳ ${timeStr}</span>
                            ${isHost ? `
                                <button type="button" class="btn btn-ghost btn-xs btn-clear-punish" data-devid="${p.device_id}" title="Ampuni & Buka Kunci">
                                    Ampuni
                                </button>
                            ` : ''}
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

    // --- Synchronized Game Arena Modal ---
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
                <div class="arena-header">
                    <div class="arena-title-area">
                        <span class="arena-game-badge">${gameData.game_name}</span>
                        <div class="arena-stakes-badge">Taruhan: Mute Kontrol ${gameData.penalty_minutes} Menit</div>
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

    // --- Mode 1: Adu Dadu Arena ---
    runDiceArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;

        stage.innerHTML = `
            <div class="dice-arena-grid">
                ${participants.map(p => `
                    <div class="dice-player-card" id="dice-card-${p.device_id}">
                        <div class="dice-p-avatar">${p.emoji || '🎧'}</div>
                        <div class="dice-p-name">${this.escape(p.nickname)}</div>
                        <div class="dice-cubes-row">
                            <div class="dice-box rolling d1">🎲</div>
                            <div class="dice-box rolling d2">🎲</div>
                        </div>
                        <div class="dice-total-score">Mengocok...</div>
                    </div>
                `).join('')}
            </div>
        `;

        // Rolling sound loop
        let rollInterval = setInterval(() => {
            this.playDiceShakeSound();
        }, 220);

        // Shake animation
        const faces = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];
        let faceInterval = setInterval(() => {
            stage.querySelectorAll('.dice-box').forEach(box => {
                box.textContent = faces[Math.floor(Math.random() * 6)];
            });
        }, 90);

        // Stop rolling and reveal results
        setTimeout(() => {
            clearInterval(rollInterval);
            clearInterval(faceInterval);

            participants.forEach(p => {
                const card = stage.querySelector(`#dice-card-${p.device_id}`);
                if (!card) return;

                const isLoser = loser && loser.device_id === p.device_id;
                const d1Box = card.querySelector('.d1');
                const d2Box = card.querySelector('.d2');
                const scoreText = card.querySelector('.dice-total-score');

                d1Box.classList.remove('rolling');
                d2Box.classList.remove('rolling');
                d1Box.textContent = faces[(p.die1 || 1) - 1];
                d2Box.textContent = faces[(p.die2 || 1) - 1];

                scoreText.innerHTML = `Total: <strong>${p.score}</strong> (${p.die1} + ${p.die2})`;

                if (isLoser) {
                    card.classList.add('is-loser');
                    const badge = document.createElement('div');
                    badge.className = 'loser-stamp';
                    badge.textContent = '💀 KALAH!';
                    card.appendChild(badge);
                } else {
                    card.classList.add('is-safe');
                }
            });

            this.showResultSummary(resultBar, loser, gameData);
        }, 3200);
    }

    // --- Mode 2: Adu Angka Arena ---
    runNumberArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;

        stage.innerHTML = `
            <div class="number-arena-grid">
                ${participants.map(p => `
                    <div class="number-player-card" id="num-card-${p.device_id}">
                        <div class="num-p-avatar">${p.emoji || '🎧'}</div>
                        <div class="num-p-name">${this.escape(p.nickname)}</div>
                        <div class="num-digital-display">
                            <span class="digital-number rolling-number">--</span>
                        </div>
                        <div class="num-status-label">Mengacak angka...</div>
                    </div>
                `).join('')}
            </div>
        `;

        // Ticking audio
        let tickInterval = setInterval(() => {
            this.playTickSound();
        }, 120);

        // Digital counter animation
        let counterInterval = setInterval(() => {
            stage.querySelectorAll('.rolling-number').forEach(box => {
                box.textContent = String(Math.floor(Math.random() * 100) + 1).padStart(2, '0');
            });
        }, 70);

        setTimeout(() => {
            clearInterval(tickInterval);
            clearInterval(counterInterval);

            participants.forEach(p => {
                const card = stage.querySelector(`#num-card-${p.device_id}`);
                if (!card) return;

                const isLoser = loser && loser.device_id === p.device_id;
                const numEl = card.querySelector('.digital-number');
                const statusEl = card.querySelector('.num-status-label');

                numEl.classList.remove('rolling-number');
                numEl.textContent = String(p.score).padStart(2, '0');

                if (isLoser) {
                    card.classList.add('is-loser');
                    statusEl.innerHTML = '<span style="color:#ef4444; font-weight:700;">💀 Terendah (Kalah!)</span>';
                } else {
                    card.classList.add('is-safe');
                    statusEl.innerHTML = '<span style="color:#10b981; font-weight:600;">Aman ✓</span>';
                }
            });

            this.showResultSummary(resultBar, loser, gameData);
        }, 3500);
    }

    // --- Mode 3: Roulette Spin Wheel Arena ---
    runWheelArena(stage, resultBar, gameData) {
        const participants = gameData.participants || [];
        const loser = gameData.loser;
        const landingDeg = gameData.landing_deg || 1800;

        stage.innerHTML = `
            <div class="wheel-arena-wrapper">
                <div class="wheel-pointer-arrow">
                    <svg width="34" height="40" viewBox="0 0 24 24" fill="#fbbf24">
                        <path d="M12 22l-10-18h20z"></path>
                    </svg>
                </div>
                <canvas id="roulette-canvas" width="460" height="460" class="wheel-canvas"></canvas>
                <div class="wheel-center-hub">🎯</div>
            </div>
        `;

        const canvas = stage.querySelector('#roulette-canvas');
        this.drawRouletteWheel(canvas, participants);

        // Animate spin with CSS transform
        const durationSec = 6.2;
        canvas.style.transition = `transform ${durationSec}s cubic-bezier(0.12, 0.8, 0.2, 1)`;
        
        // Spin tick audio
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

            // Slice arc
            ctx.beginPath();
            ctx.moveTo(radius, radius);
            ctx.arc(radius, radius, radius - 8, startAngle, endAngle);
            ctx.closePath();
            ctx.fillStyle = color;
            ctx.fill();

            // Slice border
            ctx.lineWidth = 2;
            ctx.strokeStyle = 'rgba(255,255,255,0.2)';
            ctx.stroke();

            // Participant text & emoji
            ctx.save();
            ctx.translate(radius, radius);
            ctx.rotate(startAngle + sliceAngle / 2);
            ctx.textAlign = 'right';
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 15px sans-serif';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;

            const p = participants[i];
            const label = `${p.emoji || '🎧'} ${p.nickname}`;
            ctx.fillText(label, radius - 24, 6);
            ctx.restore();
        }

        // Outer ring
        ctx.beginPath();
        ctx.arc(radius, radius, radius - 8, 0, 2 * Math.PI);
        ctx.lineWidth = 6;
        ctx.strokeStyle = '#fbbf24';
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
            <div class="result-summary-box ${isMe ? 'you-lost' : 'safe'}">
                <div class="result-headline">
                    ${isMe 
                        ? '💀 YAH, KAMU KALAH! 😭' 
                        : `🎉 Selamat! Yang Kalah: <strong>${this.escape(loser ? loser.nickname : 'Peserta')}</strong>`
                    }
                </div>
                <div class="result-penalty-info">
                    Dihukum tidak bisa mengatur musik selama <strong>${gameData.penalty_minutes} menit</strong>!
                </div>
                <button type="button" class="btn btn-outline btn-sm btn-dismiss-arena">Tutup Arena</button>
            </div>
        `;

        resultBar.querySelector('.btn-dismiss-arena').addEventListener('click', () => {
            const modal = document.getElementById('jamri-game-arena-modal');
            if (modal) modal.style.display = 'none';
        });

        // Broadcast notice to live chat
        if (window.JAMRI_APP && window.JAMRI_APP.currentChat && loser) {
            const icon = gameData.game_type === 'dice' ? '🎲' : (gameData.game_type === 'number' ? '🎯' : '🎡');
            window.JAMRI_APP.currentChat.appendActivityNotice(
                `kalah di ${gameData.game_name} dan dihukum tidak bisa atur musik selama ${gameData.penalty_minutes} menit! 😈`,
                icon,
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
}

window.JamriGames = JamriGames;
