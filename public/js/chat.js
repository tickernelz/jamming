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

        this.renderShell();
        this.setupEvents();
    }

    renderShell() {
        this.container.innerHTML = `
            <div class="chat-wrapper">
                <div class="chat-header">
                    <span class="chat-title">Live Chat</span>
                    <span id="chat-online-badge" class="badge">0 online</span>
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

    updateOnlineCount(count) {
        const badge = this.container.querySelector('#chat-online-badge');
        if (badge) {
            badge.textContent = `${count} online`;
        }
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
