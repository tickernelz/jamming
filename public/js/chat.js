/**
 * chat.js
 * Real-time room live chat with cursor-based pagination (Load More)
 * Guardrail: Emoji HANYA untuk avatar profil pengirim pesan.
 */

class JamriChat {
    constructor(containerEl, roomId, wsClient) {
        this.container = containerEl;
        this.roomId = roomId;
        this.ws = wsClient;
        this.earliestMessageId = null;
        this.hasMore = true;
        this.isLoading = false;

        this.onlineUsers = [];
        this.renderShell();
        this.setupEvents();
    }

    renderShell() {
        this.container.innerHTML = `
            <div class="chat-wrapper">
                <div class="chat-header">
                    <span class="chat-title">Live Chat</span>
                    <button type="button" id="chat-online-badge" class="badge badge-online-btn" title="Klik untuk melihat siapa saja yang online di room">
                        <span class="online-indicator-dot"></span>
                        <span id="chat-online-text">0 online</span>
                    </button>
                </div>
                <div class="chat-messages-container" id="chat-messages-box">
                    <div id="chat-load-more-container" class="load-more-box" style="display:none;">
                        <button type="button" id="btn-chat-load-more" class="btn btn-sm btn-outline">Muat Chat Sebelumnya</button>
                    </div>
                    <div id="chat-messages-list" class="messages-list"></div>
                </div>
                <form id="chat-input-form" class="chat-input-bar">
                    <input type="text" id="chat-text-input" class="chat-input" placeholder="Tulis pesan..." autocomplete="off" maxlength="300" />
                    <button type="submit" class="btn btn-primary btn-icon" title="Kirim">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="22" y1="2" x2="11" y2="13"></line>
                            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                        </svg>
                    </button>
                </form>
            </div>
        `;

        this.messagesList = this.container.querySelector('#chat-messages-list');
        this.loadMoreContainer = this.container.querySelector('#chat-load-more-container');
        this.btnLoadMore = this.container.querySelector('#btn-chat-load-more');
        this.inputForm = this.container.querySelector('#chat-input-form');
        this.inputField = this.container.querySelector('#chat-text-input');
        this.messagesBox = this.container.querySelector('#chat-messages-box');
        this.onlineBtn = this.container.querySelector('#chat-online-badge');
    }

    setupEvents() {
        this.inputForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const text = this.inputField.value.trim();
            if (text !== '') {
                this.ws.sendChatMessage(text);
                this.inputField.value = '';
            }
        });

        this.btnLoadMore.addEventListener('click', () => {
            this.loadOlderMessages();
        });

        if (this.onlineBtn) {
            this.onlineBtn.addEventListener('click', () => {
                this.showOnlineUsersModal();
            });
        }
    }

    initMessages(initialList) {
        this.messagesList.innerHTML = '';
        if (Array.isArray(initialList) && initialList.length > 0) {
            this.earliestMessageId = initialList[0].id;
            initialList.forEach(msg => this.appendMessage(msg, false));
            if (initialList.length >= 10) {
                this.loadMoreContainer.style.display = 'block';
            }
            this.scrollToBottom();
        } else {
            this.loadMoreContainer.style.display = 'none';
        }
    }

    appendMessage(msg, scroll = true) {
        const item = document.createElement('div');
        const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === msg.sender_nickname;
        item.className = `chat-bubble-row ${isMe ? 'chat-me' : 'chat-other'}`;

        const timeStr = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        item.innerHTML = `
            <div class="chat-avatar-box">
                <span class="chat-user-emoji">${msg.sender_emoji || '🎧'}</span>
            </div>
            <div class="chat-bubble-content">
                <div class="chat-meta">
                    <span class="chat-sender-name">${this.escape(msg.sender_nickname)}</span>
                    <span class="chat-timestamp">${timeStr}</span>
                </div>
                <div class="chat-text">${this.escape(msg.message)}</div>
            </div>
        `;

        this.messagesList.appendChild(item);

        if (scroll) {
            this.scrollToBottom();
        }
    }

    prependMessages(olderList) {
        if (!olderList || olderList.length === 0) {
            this.hasMore = false;
            this.loadMoreContainer.style.display = 'none';
            return;
        }

        this.earliestMessageId = olderList[0].id;
        const prevHeight = this.messagesBox.scrollHeight;

        const fragment = document.createDocumentFragment();
        olderList.forEach(msg => {
            const item = document.createElement('div');
            const isMe = window.JAMRI_USER && window.JAMRI_USER.nickname === msg.sender_nickname;
            item.className = `chat-bubble-row ${isMe ? 'chat-me' : 'chat-other'}`;
            const timeStr = new Date(msg.created_at || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            item.innerHTML = `
                <div class="chat-avatar-box">
                    <span class="chat-user-emoji">${msg.sender_emoji || '🎧'}</span>
                </div>
                <div class="chat-bubble-content">
                    <div class="chat-meta">
                        <span class="chat-sender-name">${this.escape(msg.sender_nickname)}</span>
                        <span class="chat-timestamp">${timeStr}</span>
                    </div>
                    <div class="chat-text">${this.escape(msg.message)}</div>
                </div>
            `;
            fragment.appendChild(item);
        });

        this.messagesList.insertBefore(fragment, this.messagesList.firstChild);

        // Pertahankan posisi scroll saat prepend
        const newHeight = this.messagesBox.scrollHeight;
        this.messagesBox.scrollTop += (newHeight - prevHeight);

        if (olderList.length < 10) {
            this.hasMore = false;
            this.loadMoreContainer.style.display = 'none';
        }
    }

    async loadOlderMessages() {
        if (this.isLoading || !this.hasMore || !this.earliestMessageId) return;

        this.isLoading = true;
        this.btnLoadMore.disabled = true;
        this.btnLoadMore.textContent = 'Memuat...';

        try {
            const res = await fetch(`api/chat.php?room_id=${encodeURIComponent(this.roomId)}&before_id=${this.earliestMessageId}&limit=10`);
            const data = await res.json();
            if (data.success) {
                this.prependMessages(data.messages);
            }
        } catch (e) {
            console.error('Failed to load older messages:', e);
        } finally {
            this.isLoading = false;
            this.btnLoadMore.disabled = false;
            this.btnLoadMore.textContent = 'Muat Chat Sebelumnya';
        }
    }

    setOnlineUsers(users) {
        this.onlineUsers = Array.isArray(users) ? users : [];
        this.updateOnlineCount(this.onlineUsers.length);

        // If modal is currently open, refresh list
        const modal = document.getElementById('modal-room-online-users');
        if (modal && modal.style.display === 'flex') {
            this.renderOnlineUsersList(modal);
        }
    }

    updateOnlineCount(count) {
        const text = this.container.querySelector('#chat-online-text');
        if (text) {
            text.textContent = `${count} online`;
        }
    }

    showOnlineUsersModal() {
        let modal = document.getElementById('modal-room-online-users');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'modal-room-online-users';
            modal.className = 'modal-backdrop';
            modal.style.cssText = 'display:none; position:fixed; inset:0; z-index:10000; background:rgba(0,0,0,0.65); backdrop-filter:blur(6px); -webkit-backdrop-filter:blur(6px); align-items:center; justify-content:center; padding:16px;';
            modal.innerHTML = `
                <div class="modal-card online-users-modal-box" style="max-width:380px; width:100%; border-radius:var(--radius-lg); background:var(--bg-surface); border:1px solid var(--border-color); box-shadow:var(--shadow-lg); overflow:hidden; color:var(--text-primary);">
                    <div style="display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border-subtle); background:var(--bg-surface-elevated);">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color:var(--primary);">
                                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                                <circle cx="9" cy="7" r="4"></circle>
                                <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
                                <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
                            </svg>
                            <span id="online-users-modal-title" style="font-size:14px; font-weight:700; color:var(--text-primary);">Peserta Room</span>
                        </div>
                        <button type="button" class="btn btn-ghost btn-icon btn-sm btn-close-modal" style="width:28px; height:28px; border-radius:6px;" title="Tutup">✕</button>
                    </div>
                    <div style="padding:12px 14px; max-height:360px; overflow-y:auto;" id="online-users-list-container" class="online-users-list"></div>
                </div>
            `;
            document.body.appendChild(modal);

            modal.querySelectorAll('.btn-close-modal').forEach(btn => {
                btn.addEventListener('click', () => { modal.style.display = 'none'; });
            });
            modal.addEventListener('click', (e) => {
                if (e.target === modal) modal.style.display = 'none';
            });
        }

        const onEsc = (e) => {
            if (e.key === 'Escape' && modal) {
                modal.style.display = 'none';
                window.removeEventListener('keydown', onEsc);
            }
        };
        window.addEventListener('keydown', onEsc);

        this.renderOnlineUsersList(modal);
        modal.style.display = 'flex';
    }

    renderOnlineUsersList(modal) {
        const title = modal.querySelector('#online-users-modal-title');
        if (title) title.textContent = `Peserta Room (${this.onlineUsers.length})`;

        const container = modal.querySelector('#online-users-list-container');
        if (!container) return;

        if (this.onlineUsers.length === 0) {
            container.innerHTML = '<div style="padding:20px; text-align:center; color:var(--text-muted); font-size:13px;">Belum ada peserta lain di room ini.</div>';
            return;
        }

        const now = Math.floor(Date.now() / 1000);
        const myNickname = window.JAMRI_USER ? window.JAMRI_USER.nickname : '';
        container.innerHTML = this.onlineUsers.map(user => {
            const isMe = user.nickname === myNickname;
            const isPunished = (this.punishments || []).some(p => 
                (p.nickname === user.nickname || (user.device_id && p.device_id === user.device_id)) && p.until > now
            );
            return `
                <div class="online-user-row ${isMe ? 'is-me' : ''}" style="display:flex; align-items:center; justify-content:space-between; padding:8px 12px; margin-bottom:6px; background:var(--bg-surface-elevated); border:1px solid var(--border-subtle); border-radius:var(--radius-sm);">
                    <div style="display:flex; align-items:center; gap:10px; min-width:0;">
                        <div class="online-user-avatar" style="width:32px; height:32px; border-radius:50%; background:var(--bg-surface); border:1px solid var(--border-subtle); display:flex; align-items:center; justify-content:center; font-size:16px; flex-shrink:0;">${user.emoji || '🎧'}</div>
                        <div style="display:flex; align-items:center; gap:6px; min-width:0;">
                            <span class="online-user-name" style="font-size:13px; font-weight:600; color:var(--text-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${this.escape(user.nickname)}</span>
                            ${isMe ? '<span class="user-role-badge me" style="font-size:10px; padding:2px 6px; border-radius:4px; background:var(--primary-light); color:var(--primary); font-weight:600;">Anda</span>' : ''}
                            ${user.is_host ? '<span class="user-role-badge host" style="font-size:10px; padding:2px 6px; border-radius:4px; background:rgba(217, 119, 6, 0.15); color:var(--warning); font-weight:600;">Host</span>' : ''}
                            ${isPunished ? '<span class="user-role-badge punished" style="font-size:10px; padding:2px 6px; border-radius:4px; background:var(--danger-light); color:var(--danger); font-weight:600;">Muted</span>' : ''}
                        </div>
                    </div>
                    <span style="width:8px; height:8px; border-radius:50%; background:var(--success); box-shadow:0 0 6px rgba(22, 163, 74, 0.4); flex-shrink:0;" title="Online"></span>
                </div>
            `;
        }).join('');
    }

    setPunishments(list) {
        this.punishments = list || [];
        const modal = document.getElementById('modal-room-online-users');
        if (modal && modal.style.display !== 'none') {
            this.renderOnlineUsersList(modal);
        }
    }

    appendActivityNotice(actionText, icon = '', triggeredBy = '') {
        const lastEl = this.messagesList.lastElementChild;
        if (lastEl && lastEl.classList.contains('chat-activity-notice')) {
            const prevUser = lastEl.getAttribute('data-triggered-by');
            const prevAction = lastEl.getAttribute('data-action-text');
            if (prevUser === triggeredBy && prevAction === actionText) {
                let count = parseInt(lastEl.getAttribute('data-repeat-count') || '1', 10) + 1;
                lastEl.setAttribute('data-repeat-count', count);
                let badge = lastEl.querySelector('.activity-repeat-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'activity-repeat-badge';
                    badge.style.cssText = 'display:inline-block; margin-left:6px; font-size:11px; font-weight:700; background:rgba(99,102,241,0.22); color:var(--accent-primary, #818cf8); border:1px solid rgba(99,102,241,0.3); padding:1px 6px; border-radius:10px; vertical-align:middle; transition:transform 0.15s ease;';
                    const actTextSpan = lastEl.querySelector('.activity-text');
                    if (actTextSpan) actTextSpan.appendChild(badge);
                }
                badge.textContent = `${count}x`;
                badge.style.transform = 'scale(1.25)';
                setTimeout(() => { if (badge) badge.style.transform = 'scale(1)'; }, 150);
                this.scrollToBottom();
                return;
            }
        }

        const el = document.createElement('div');
        el.className = 'chat-activity-notice';
        el.setAttribute('data-triggered-by', triggeredBy || '');
        el.setAttribute('data-action-text', actionText || '');
        el.setAttribute('data-repeat-count', '1');
        el.innerHTML = `
            <span class="activity-bullet" style="display:inline-block; width:6px; height:6px; border-radius:50%; background:var(--accent-primary, #6366f1); margin-right:6px; vertical-align:middle; opacity:0.8;"></span>
            <span class="activity-text">
                <strong class="activity-user">${this.escape(triggeredBy)}</strong> ${this.escape(actionText)}
            </span>
        `;
        this.messagesList.appendChild(el);
        this.scrollToBottom();
    }

    scrollToBottom() {
        this.messagesBox.scrollTop = this.messagesBox.scrollHeight;
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

window.JamriChat = JamriChat;
