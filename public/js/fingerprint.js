/**
 * fingerprint.js
 * Device fingerprinting & User Profile (Nickname & Avatar Emoji)
 * Pengguna bebas memilih nama & emoji serta bisa mengubahnya kapan saja!
 */

class JamriAuth {
    static EMOJI_AVATARS = [
        '🎧', '🎸', '🎹', '🥁', '🎷', '🎙️', '📻', '☕',
        '🦊', '🐯', '🐼', '🦁', '🐨', '🐺', '🦉', '🐙',
        '⚡', '🌊', '🌙', '🪐', '🕹️', '👾', '🎯', '🥑'
    ];

    static async init() {
        const deviceId = this.getOrCreateDeviceId();
        const user = await this.checkUser(deviceId);

        if (!user) {
            this.showProfileModal({ device_id: deviceId, nickname: '', emoji: this.EMOJI_AVATARS[0] }, false);
        } else {
            window.JAMRI_USER = user;
            document.dispatchEvent(new CustomEvent('jamri:user_ready', { detail: user }));
            this.updateHeaderProfile(user);
        }

        // Klik badge profile di navbar untuk mengubah nama dan emoji kapan saja
        const badge = document.getElementById('user-profile-badge');
        if (badge) {
            badge.style.cursor = 'pointer';
            badge.title = 'Klik untuk ubah nama atau emoji profil';
            badge.addEventListener('click', () => {
                if (window.JAMRI_USER) {
                    this.showProfileModal(window.JAMRI_USER, true);
                }
            });
        }
    }

    static getOrCreateDeviceId() {
        let id = localStorage.getItem('jamri_device_id');
        if (!id) {
            const raw = [
                navigator.userAgent,
                navigator.language,
                screen.width + 'x' + screen.height,
                screen.colorDepth,
                navigator.hardwareConcurrency || 4,
                Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                Math.random().toString(36).substring(2) + Date.now().toString(36)
            ].join('###');

            let hash = 0;
            for (let i = 0; i < raw.length; i++) {
                hash = ((hash << 5) - hash) + raw.charCodeAt(i);
                hash |= 0;
            }
            id = 'dev_' + Math.abs(hash).toString(16) + '_' + Math.random().toString(36).substring(2, 10);
            localStorage.setItem('jamri_device_id', id);
        }
        return id;
    }

    static async checkUser(deviceId) {
        try {
            const res = await fetch(`api/auth.php?device_id=${encodeURIComponent(deviceId)}`);
            const data = await res.json();
            return data.exists ? data.user : null;
        } catch (e) {
            console.error('Auth check error:', e);
            return null;
        }
    }

    static showProfileModal(currentUser, isEditMode = false) {
        let selectedEmoji = currentUser.emoji || this.EMOJI_AVATARS[0];
        let existingModal = document.getElementById('onboarding-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'onboarding-modal';
        modal.className = 'modal-backdrop active';
        modal.innerHTML = `
            <div class="modal-card">
                <div class="modal-header">
                    <div class="modal-title-row">
                        <h2 class="modal-title">${isEditMode ? 'Ubah Profil & Emoji' : 'Selamat Datang di Jamri'}</h2>
                        ${isEditMode ? `
                            <button type="button" class="btn-close-modal" id="btn-close-profile-modal">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                </svg>
                            </button>
                        ` : ''}
                    </div>
                    <p class="modal-subtitle">${isEditMode ? 'Ganti nama panggilan atau emoji avatar sesuka Anda.' : 'Pilih nama panggilan dan avatar untuk mulai jamming bersama rekan kantor.'}</p>
                </div>
                <div class="modal-body">
                    <div class="form-group">
                        <label class="form-label" for="onboarding-nickname">Nickname</label>
                        <input type="text" id="onboarding-nickname" class="form-input" placeholder="contoh: alex_dev" maxlength="25" autocomplete="off" value="${this.escapeHtml(currentUser.nickname || '')}" />
                        <div class="input-hint">Bebas menggunakan nama apa saja (tidak wajib unik).</div>
                    </div>

                    <div class="form-group">
                        <label class="form-label">Pilih Avatar Emoji</label>
                        <div class="emoji-grid" id="emoji-picker-grid">
                            ${this.EMOJI_AVATARS.map((em) => `
                                <button type="button" class="emoji-btn ${em === selectedEmoji ? 'selected' : ''}" data-emoji="${em}">${em}</button>
                            `).join('')}
                        </div>
                    </div>
                </div>
                <div class="modal-footer">
                    ${isEditMode ? '<button type="button" class="btn btn-outline" id="btn-cancel-profile">Batal</button>' : ''}
                    <button type="button" id="btn-save-profile" class="btn btn-primary" style="${isEditMode ? '' : 'width:100%;'}">
                        ${isEditMode ? 'Simpan Perubahan' : 'Mulai Sekarang'}
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        if (isEditMode) {
            const closeBtn = modal.querySelector('#btn-close-profile-modal');
            const cancelBtn = modal.querySelector('#btn-cancel-profile');
            const close = () => modal.remove();
            if (closeBtn) closeBtn.addEventListener('click', close);
            if (cancelBtn) cancelBtn.addEventListener('click', close);
        }

        // Emoji picker
        const grid = modal.querySelector('#emoji-picker-grid');
        grid.addEventListener('click', (e) => {
            const btn = e.target.closest('.emoji-btn');
            if (!btn) return;
            grid.querySelectorAll('.emoji-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
            selectedEmoji = btn.dataset.emoji;
        });

        const inputNick = modal.querySelector('#onboarding-nickname');
        const btnSave = modal.querySelector('#btn-save-profile');

        btnSave.addEventListener('click', async () => {
            let nickname = inputNick.value.trim();
            if (nickname.length === 0) {
                nickname = 'Kawan Jamming';
            }

            btnSave.disabled = true;
            btnSave.textContent = 'Menyimpan...';

            try {
                const res = await fetch('api/auth.php', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        device_id: currentUser.device_id,
                        nickname: nickname,
                        emoji: selectedEmoji
                    })
                });

                const data = await res.json();
                if (data.success) {
                    window.JAMRI_USER = data.user;
                    modal.remove();
                    document.dispatchEvent(new CustomEvent('jamri:user_ready', { detail: data.user }));
                    this.updateHeaderProfile(data.user);

                    // Update WebSocket jika sedang di room
                    if (window.JAMRI_APP && window.JAMRI_APP.wsClient && window.JAMRI_APP.wsClient.isConnected) {
                        window.JAMRI_APP.wsClient.user = data.user;
                    }
                } else {
                    alert(data.error || 'Gagal menyimpan profil.');
                    btnSave.disabled = false;
                    btnSave.textContent = isEditMode ? 'Simpan Perubahan' : 'Mulai Sekarang';
                }
            } catch (err) {
                alert('Koneksi bermasalah saat menyimpan profil.');
                btnSave.disabled = false;
                btnSave.textContent = isEditMode ? 'Simpan Perubahan' : 'Mulai Sekarang';
            }
        });
    }

    static updateHeaderProfile(user) {
        const el = document.getElementById('user-profile-badge');
        if (el) {
            el.innerHTML = `
                <span class="user-emoji">${(typeof safeEmoji === 'function' ? safeEmoji(user.emoji) : '🎧')}</span>
                <span class="user-nickname">${this.escapeHtml(user.nickname || 'Pengguna')}</span>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--text-muted); margin-left:2px;">
                    <path d="M12 20h9"></path>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                </svg>
            `;
        }
    }

    static escapeHtml(str) {
        return (str || '').replace(/[&<>"']/g, m => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[m]));
    }
}

window.JamriAuth = JamriAuth;
