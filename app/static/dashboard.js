// Global 401 Handler Wrapper
const originalFetch = window.fetch;
window.fetch = async function (resource, options = {}) {
    // Extract token from cookie helper
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
    }

    const token = getCookie('access_token');

    // Handle both URL strings and Request objects
    let request;
    if (resource instanceof Request) {
        request = resource.clone();
    }

    // Merge headers safely
    const headers = new Headers(options.headers || (request ? request.headers : {}));
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`);
    }

    const mergedOptions = {
        ...options,
        credentials: options.credentials || 'same-origin',
        headers: headers
    };

    try {
        const response = await originalFetch.call(window, request || resource, mergedOptions);
        if (response.status === 401) {
            window.location.href = '/login';
        }
        return response;
    } catch (e) {
        console.error('[Fetch Override Error]', e);
        throw e;
    }
};

const urlInput = document.getElementById('urlInput');
const fetchBtn = document.getElementById('fetchBtn');
const videoPreview = document.getElementById('videoPreview');
const thumbnail = document.getElementById('thumbnail');
const videoTitle = document.getElementById('videoTitle');
const videoDuration = document.getElementById('videoDuration');
const qualitySelect = document.getElementById('qualitySelect');

// Buttons
const downloadBtn = document.getElementById('downloadBtn');
const queueBtn = document.getElementById('queueBtn');
const queueList = document.getElementById('queueList');
const grid = document.getElementById('queueGrid');

// Logout Handler
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) {
    logoutBtn.addEventListener('click', (e) => {
        e.preventDefault();
        document.cookie = 'access_token=; Max-Age=0; path=/;';
        window.location.href = '/login';
    });
}

// Mobile Menu Toggle
const menuBtn = document.getElementById('menuBtn');
const sidebar = document.querySelector('.sidebar');
if (menuBtn && sidebar) {
    menuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('open');
    });
}

let currentUrl = "";
let currentTitle = "";
let currentThumbnail = "";

// Search & Filter State - MUST be declared before updateQueue() call
let globalJobs = [];
let currentSearch = "";
let currentFilter = "all";
let currentSort = "newest";

// Robust sync state to prevent stale server data from restoring removed items
window.pendingRemovals = new Set();

// Function to show/hide System Logs based on preference
function applySystemLogsVisibility(show) {
    const systemLogsCard = document.getElementById('systemLogsCard');
    if (systemLogsCard) {
        systemLogsCard.style.display = show ? 'block' : 'none';
    }
}

// Add listener for System Logs toggle
const settingShowSystemLogs = document.getElementById('settingShowSystemLogs');
if (settingShowSystemLogs) {
    settingShowSystemLogs.addEventListener('change', (e) => {
        const show = e.target.checked;
        applySystemLogsVisibility(show);
        localStorage.setItem('showSystemLogs', show);
    });

    // Init state
    const saved = localStorage.getItem('showSystemLogs');
    if (saved !== null) {
        settingShowSystemLogs.checked = (saved === 'true');
        applySystemLogsVisibility(saved === 'true');
    }
}

// Auto-start Downloads Setting
const settingAutoStart = document.getElementById('settingAutoStart');
if (settingAutoStart) {
    settingAutoStart.addEventListener('change', (e) => {
        localStorage.setItem('autoStartDownloads', e.target.checked);
        showToast(`Auto-start ${e.target.checked ? 'enabled' : 'disabled'}`, 'success');
    });

    // Init state
    const savedAutoStart = localStorage.getItem('autoStartDownloads');
    if (savedAutoStart !== null) {
        settingAutoStart.checked = (savedAutoStart === 'true');
    }
}


// Initial Queue Load
updateQueue();

const dashboardSearch = document.getElementById('dashboardSearch');
const filterBtns = document.querySelectorAll('.filter-chips button');
const dashboardSort = document.getElementById('dashboardSort');

if (dashboardSearch) {
    dashboardSearch.addEventListener('input', (e) => {
        currentSearch = e.target.value.toLowerCase();
        renderQueue(globalJobs);
    });
}

if (filterBtns) {
    filterBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            // Manual override? The requirements say "Automatic". 
            // But usually buttons are clickable.
            // Let's allow click to set currentFilter, but next auto-update might revert it 
            // if we strictly follow "Automatically detect".
            // However, for "Select All", that's a different button.
            // The user listed "All, Downloading, Completed" as filter buttons.
            // Let's Update active state
            if (btn.id === 'btnSelectAll') {
                toggleSelectAll();
                return;
            }

            activateFilter(btn.dataset.filter);
        });
    });
}

if (dashboardSort) {
    dashboardSort.addEventListener('change', (e) => {
        currentSort = e.target.value;
        renderQueue(globalJobs);
    });
}



const handleFetch = async () => {
    const url = urlInput.value.trim();
    if (!url) {
        showToast('Please enter a video URL', 'error');
        return;
    }

    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<span class="material-icons spin-animation">autorenew</span>';

    try {
        const response = await fetch('/api/fetch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.detail || 'Failed to fetch video info');
        }

        const data = await response.json();

        // Store current info
        currentUrl = url;
        currentTitle = data.title;
        currentThumbnail = data.thumbnail;

        // Update UI
        thumbnail.src = data.thumbnail;
        videoTitle.textContent = data.title;
        videoDuration.textContent = `Duration: ${data.duration}`;

        // Populate quality options
        qualitySelect.innerHTML = '';
        data.formats.forEach(fmt => {
            const option = document.createElement('option');
            option.value = fmt.id;
            option.textContent = `${fmt.res} - ${fmt.ext} (${fmt.size})`;
            qualitySelect.appendChild(option);
        });

        // --- INSTANT DOWNLOAD CHECK ---
        const autoStart = localStorage.getItem('autoStartDownloads') === 'true';
        if (autoStart) {
            console.log('[AutoStart] Instant Download Triggered. Skipping preview.');

            // Default to best format (first in list usually, or we can pick)
            const bestFormat = data.formats.length > 0 ? data.formats[0].id : null;

            // Trigger Queue Add + Start
            await fetch('/api/queue/add', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: currentUrl,
                    format_id: bestFormat,
                    title: currentTitle,
                    thumbnail: currentThumbnail
                })
            });

            // Trigger Start
            await fetch('/api/queue/start', { method: 'POST' });

            showToast('Instant Download Started!', 'success');

            // Clear Input
            urlInput.value = "";
            handleNav('Home'); // Ensure we are on Home tab to see it
            updateQueue();

            return; // EXIT FUNCTION HERE (Skip Preview)
        }
        // -----------------------------

        videoPreview.classList.remove('hidden');
        videoPreview.classList.remove('entrance-anim');
        void videoPreview.offsetWidth; // Force reflow
        videoPreview.classList.add('entrance-anim');

    } catch (error) {
        console.error('Fetch error:', error);
        let errorMsg = error.message;

        // Handle timeouts specially
        if (errorMsg.includes('timed out') || errorMsg.includes('unavailable')) {
            showToast('Request timed out. The video may be unavailable or region-locked.', 'error');
        } else {
            showToast('Error: ' + errorMsg, 'error');
        }
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = '<span class="material-icons">arrow_forward</span>';
    }
};

fetchBtn.addEventListener('click', handleFetch);

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        handleFetch();
    }
});

queueBtn.addEventListener('click', async () => {
    if (!currentUrl) return;

    const format_id = qualitySelect.value;
    const btnText = queueBtn.innerHTML;
    queueBtn.disabled = true;
    queueBtn.textContent = "Starting...";

    try {
        // Add to queue
        const addRes = await fetch('/api/queue/add', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                url: currentUrl,
                format_id: format_id,
                title: currentTitle,
                thumbnail: currentThumbnail
            })
        });

        const data = await addRes.json();

        // The user manually clicked the 'Download' button, force start it immediately
        if (data.job_id) {
            await fetch(`/api/queue/${data.job_id}/force_start`, { method: 'POST' });
        }

        showToast('Download started!', 'success');

        // Smooth exit for preview card
        videoPreview.classList.add('leaving');

        setTimeout(() => {
            // Reset input
            urlInput.value = "";
            videoPreview.classList.add('hidden');
            videoPreview.classList.remove('leaving');

            // Auto-switch to Home (Active Downloads) so user sees the new job
            handleNav('Home');
            updateQueue(); // immediate update
        }, 400);
    } catch (e) {
        showToast("Failed to start download", "error");
    } finally {
        queueBtn.disabled = false;
        queueBtn.innerHTML = btnText;
    }
});

const cancelPreviewBtn = document.getElementById('cancelPreviewBtn');
if (cancelPreviewBtn) {
    cancelPreviewBtn.addEventListener('click', () => {
        // Smooth exit for preview card
        if (videoPreview) {
            videoPreview.classList.add('leaving');
            setTimeout(() => {
                // Reset input
                if (urlInput) urlInput.value = "";
                videoPreview.classList.add('hidden');
                videoPreview.classList.remove('leaving');
            }, 400);
        }
    });
}

// Start Queue logic removed


function handleWsMessage(data) {
    if (data.type === 'progress' || data.type === 'error') {
        updateCard(data);
    }
}

// WebSocket Connection
let socket;
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

    socket.onopen = () => {
        console.log("[WS] Connected");
    };

    socket.onmessage = function (event) {
        // console.log("[WS] Message:", event.data);
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'progress') {
                // console.log(`[WS] Speed: ${data.speed} ETA: ${data.eta}`);
            }
            handleWsMessage(data);
        } catch (e) {
            console.error("[WS] Parse error", e);
        }
    };

    socket.onclose = () => {
        console.log("[WS] Disconnected. Reconnecting in 3s...");
        setTimeout(connectWebSocket, 3000);
    };

    socket.onerror = (err) => {
        console.error("[WS] Error:", err);
        socket.close();
    };
}

// Start connection
connectWebSocket();

// Still useful to fetch all on load
async function updateQueue() {
    try {
        if (globalJobs.length === 0) renderSkeletons(3); // Show skeletons if no data yet
        const res = await fetch(`/api/queue?t=${Date.now()}`);
        if (!res.ok) return;
        const jobs = await res.json();

        // Reconcile pendingRemovals: ONLY clear IDs that are officially resolved by the server state
        const serverVisibleIds = new Set(jobs.filter(j => j.is_in_downloads == 1 || j.is_in_downloads === true).map(j => j.id));
        window.pendingRemovals.forEach(id => {
            // Only stop tracking if the ID is missing from the server OR it's officially marked as not in downloads
            if (!serverVisibleIds.has(id)) {
                window.pendingRemovals.delete(id);
            }
        });

        globalJobs = jobs; // Store globally
        updateHomeFilters(globalJobs); // Auto-switch filters based on content
        updateClearButtonVisibility(); // Update clear button visibility
        renderQueue(globalJobs); // Live Refresh based on server data
    } catch (e) {
        console.error("Poll error", e);
        const grid = document.getElementById('queueGrid');
        if (grid && grid.querySelector('.skeleton-card')) {
            grid.innerHTML = `
                <div class="empty-placeholder">
                    <span class="material-icons large-icon error-icon" style="color:var(--error)">error_outline</span>
                    <p>Failed to load downloads.</p>
                    <small style="color:var(--text-secondary)">Check server connection.</small>
                    <button class="btn-text" onclick="updateQueue()" style="margin-top:8px">Try Again</button>
                </div>
            `;
        }
    }
}

// Helper: Toggle Clear Button based on content
function updateClearButtonVisibility() {
    const clearBtn = document.getElementById('toolbarClearBtn');
    if (!clearBtn) return;

    // Check availability
    const hasClearable = globalJobs.some(j => j.status === 'completed' || j.status === 'error' || j.status === 'canceled');

    // Check context (only show on main pages)
    // Note: currentPage is global
    if ((currentPage === 'Home' || currentPage === 'Downloads') && hasClearable) {
        clearBtn.style.display = 'inline-flex';
    } else {
        clearBtn.style.display = 'none';
    }
}

function updateCard(data) {
    // Find existing card
    let card = document.querySelector(`.video-card[data-id="${data.job_id}"]`);

    // If card doesn't exist yet (e.g. started by another tab), refresh whole grid
    if (!card) {
        // Check if we have the placeholder
        const placeholder = document.querySelector('.empty-placeholder');
        if (placeholder) {
            updateQueue();
            return;
        }
        updateQueue();
        return;
    }

    // Update card DOM
    const progressBar = card.querySelector('.card-progress-bar');
    const badge = card.querySelector('.status-badge');
    const cardBody = card.querySelector('.card-body');

    if (progressBar) {
        progressBar.style.width = `${data.progress}%`;
        // Force opacity/visibility just in case
        progressBar.style.opacity = '1';
    }
    if (badge) {
        badge.textContent = data.status;
        badge.className = `status-badge status-${data.status}`;
    }

    // Critical: Update data attributes
    card.dataset.status = data.status;
    if (data.filename) {
        card.dataset.filename = data.filename.split(/[/\\]/).pop();
    }

    const metaDiv = card.querySelector('.card-meta');

    if (data.status === 'downloading') {
        // Ensure progress bar container exists
        let thumbContainer = card.querySelector('.card-thumb-container');
        if (!thumbContainer.querySelector('.card-progress-overlay')) {
            thumbContainer.insertAdjacentHTML('beforeend', `
                    <div class="card-progress-overlay">
                        <div class="card-progress-bar" style="width: ${data.progress}%"></div>
                    </div>
                `);
        }

        // Update Meta Stats with formatted HTML
        // Structure: Speed | Percent | ETA
        metaDiv.innerHTML = ''; // Clear to rebuild clean state

        // Status Badge (keep it outside or inside? layout has badge separate in original HTML)
        // Original HTML: <span class="status-badge ...">...</span> <span class="meta-speed">...</span>
        // Let's reconstruct consistent layout: [Badge] [Spacer] [Speed] [Percent] [ETA]

        const badgeSpan = document.createElement('span');
        if (data.status === 'downloading') {
            badgeSpan.className = 'status-icon-downloading material-icons';
            badgeSpan.textContent = 'autorenew';
        } else if (data.status !== 'completed') {
            badgeSpan.className = `status-badge status-${data.status}`;
            badgeSpan.textContent = data.status;
        }
        if (badgeSpan.textContent) metaDiv.appendChild(badgeSpan);

        if (data.speed) {
            metaDiv.innerHTML += `<span class="meta-speed">${data.speed}</span>`;
        }
        metaDiv.innerHTML += `<span class="meta-percent">${Math.round(data.progress)}%</span>`;
        if (data.eta && data.eta !== 'N/A') {
            metaDiv.innerHTML += `<span class="meta-eta">ETA: ${data.eta}</span>`;
        }

    } else if (data.status === 'completed') {
        // --- SMOOTH TRANSITION START ---

        // 1. Remove progress bar (fade out first?)
        let overlay = card.querySelector('.card-progress-overlay');
        if (overlay) {
            overlay.style.opacity = '0';
            setTimeout(() => overlay.remove(), 500);
        }

        // 2. Add 'video-card-completed' class
        card.classList.add('video-card-completed');

        // 3. Inject "Play" icon hint if missing
        let thumbContainer = card.querySelector('.card-thumb-container');
        if (thumbContainer && !thumbContainer.querySelector('.play-icon-hint')) {
            thumbContainer.insertAdjacentHTML('beforeend',
                `<div class="play-icon-hint entrance-anim"><span class="material-icons">play_circle</span></div>`
            );
            // Ensure onclick plays video
            thumbContainer.setAttribute('onclick', "openPlayer(this.closest('.video-card')); event.stopPropagation();");

            // Add hover preview data
            if (!thumbContainer.querySelector('.video-preview-overlay')) {
                thumbContainer.insertAdjacentHTML('beforeend', `<div class="video-preview-overlay" data-job-id="${data.job_id}"></div>`);
            }
        }

        // 4. Update Actions Footer completely
        const footerActions = card.querySelector('.card-body-actions');
        if (footerActions) {
            // Check if in library (unlikely for a fresh download, but good to be safe)
            const inLibrary = data.is_in_library;

            // Re-render actions
            // Re-render actions
            footerActions.innerHTML = `
                <button class="btn-card-action danger" onclick="deleteVideo('${data.job_id}', '${currentPage.toLowerCase()}'); event.stopPropagation()" title="Remove"><span class="material-icons">delete</span></button>
                ${inLibrary ? `
                <button class="btn-card-action danger" onclick="deleteVideo('${data.job_id}', 'library'); event.stopPropagation()" title="Remove from Library"><span class="material-icons" style="color:var(--accent)">bookmark_remove</span></button>
                ` : `
                <button class="btn-card-action" onclick="window.moveToLibrary(['${data.job_id}']); event.stopPropagation()" title="Move to Library"><span class="material-icons">bookmark_add</span></button>
                `}
                <button class="btn-card-action" onclick="window.openJobFolder('${data.job_id}'); event.stopPropagation()" title="Open File"><span class="material-icons">folder</span></button>
            `;

            // Add flash effect to indicate completion
            card.style.animation = 'none';
            card.offsetHeight; /* trigger reflow */
            card.style.animation = 'pulseGreen 1s ease';
        }

        // 5. Re-attach preview listeners (lightweight)
        if (window.attachVideoPreviewListeners) window.attachVideoPreviewListeners();

        // 6. Update Stats to empty or "Done"
        if (metaDiv) metaDiv.innerHTML = '';

        // --- SMOOTH TRANSITION END ---

    } else if (data.status === 'error' || data.status === 'canceled') {
        updateQueue(); // Errors are rare, full refresh is fine
    }

    // Update global state for auto-filter logic
    const gIndex = globalJobs.findIndex(j => j.id === data.job_id);
    if (gIndex > -1) {
        globalJobs[gIndex].status = data.status;
        if (data.progress) globalJobs[gIndex].progress = data.progress;
    }

    updateHomeFilters(globalJobs);
    checkActiveStatus(globalJobs); // Force CSS refresh on live updates
    updateClearButtonVisibility(); // Update Clear button when job status changes
}

let manualFilterOverride = false;

// Auto-Filter Logic
function updateHomeFilters(jobs) {
    if (currentPage !== 'Home') return;

    const activeJobs = jobs.filter(j => !window.pendingRemovals.has(j.id) && (j.is_in_downloads == 1 || j.is_in_downloads === true));
    const hasDownloading = activeJobs.some(j => j.status === 'downloading' || j.status === 'queued' || j.status === 'verifying' || j.status === 'detected');

    // If the user was watching the "downloading" tab and it finished, forcefully release their manual lock so we can transition them
    if (currentFilter === 'downloading' && !hasDownloading) {
        manualFilterOverride = false;
    }

    // If user has manually selected a filter (and it isn't the dead downloading tab), do not auto-switch
    if (manualFilterOverride) return;

    if (activeJobs.length === 0) {
        activateFilter('all', false); // false = not manual
        return;
    }

    if (hasDownloading) {
        activateFilter('downloading', false);
    } else {
        const hasCompleted = activeJobs.some(j => j.status === 'completed');
        if (hasCompleted) {
            activateFilter('completed', false);
        } else {
            activateFilter('all', false);
        }
    }
}

function activateFilter(filterName, isManual = true) {
    if (isManual) {
        manualFilterOverride = true;
    }

    if (currentFilter === filterName) return;
    currentFilter = filterName;

    // Visual Update - Use correct selector for chips
    const btns = document.querySelectorAll('.filter-chips .chip');
    btns.forEach(btn => {
        if (btn.dataset.filter === filterName) btn.classList.add('active');
        else btn.classList.remove('active');
    });

    // Re-render
    renderQueue(globalJobs);
}


// Open Downloads Folder
// Open Folder logic removed

// Cancel / Remove / Open handlers attached via grid event delegation
// Queue Action Handlers
window.startDownload = async function (jobId, btn, force = false) {
    // --- [ OPTIMISTIC UI START ] ---
    const cards = document.querySelectorAll(`.video-card[data-id="${jobId}"]`);
    cards.forEach(card => card.classList.add('download-starting'));

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="material-icons spin">refresh</span>';
    }
    // --- [ OPTIMISTIC UI END ] ---

    try {
        const endpoint = force ? `/api/queue/${jobId}/force_start` : `/api/queue/${jobId}/enqueue`;
        const res = await fetch(endpoint, { method: 'POST' });
        if (res.ok) {
            showToast('Download started', 'success');

            // Force Switch to Downloading Tab (Auto Mode)
            manualFilterOverride = false;
            activateFilter('downloading', false);

            // Give animation a moment then refresh
            setTimeout(updateQueue, 500);
        } else {
            cards.forEach(card => card.classList.remove('download-starting'));
            showToast('Failed to start download', 'error');
        }
    } catch (e) {
        cards.forEach(card => card.classList.remove('download-starting'));
        showToast('Error starting download', 'error');
    } finally {
        if (btn) btn.disabled = false;
    }
};

window.deleteVideo = async function (jobId, section) {
    // Confirm removed for instant deletion
    // if (!confirm("Are you sure you want to delete this video?")) return;

    // Track removal to prevent re-render from bringing it back
    window.pendingRemovals.add(jobId);

    showToast("Deleting video...", "info");

    // 1️⃣ Optimistic UI: visually remove immediately with Premium Animation
    const cards = document.querySelectorAll(`.video-card[data-id="${jobId}"]`);
    cards.forEach(card => {
        card.classList.remove('selected');
        card.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.9) translateY(10px)';

        // Remove from DOM after animation
        setTimeout(() => {
            if (card.parentNode) {
                card.remove();
            }
        }, 300);
    });

    try {
        // 2️⃣ Perform backend deletion
        const response = await fetch(`/api/delete/${jobId}`, {
            method: 'DELETE'
        });

        if (!response.ok) throw new Error(`Server failed: ${response.statusText}`);

        // 3️⃣ Update selection arrays
        if (window.selectedJobs) {
            window.selectedJobs = window.selectedJobs.filter(id => id !== jobId);
            updateBulkBar();
        }

        showToast("Video deleted successfully", "success");

        // 4️⃣  No need to wait for updateQueue or refresh sections immediately
        // because we've already removed it from the DOM.
        // We can do a silent background sync later or let the next poll handle it.
        // But for consistency:
        if (section === 'library') {
            // Optional: silent sync
            // loadLibrary(); 
        } else {
            // updateQueue(); 
        }

    } catch (e) {
        // Revert animation if deletion fails
        window.pendingRemovals.delete(jobId);

        // If we removed it from DOM, we might need to reload or re-fetch.
        // But since we did a setTimeout, there's a race. 
        // Simplest fallback: ERROR toast + refresh
        console.error("Delete Error:", e);
        showToast("Failed to delete video. refreshing...", "error");
        setTimeout(() => window.location.reload(), 1500);
    }
};

// Cancel function kept for active downloads
window.cancelJob = async function (jobId, btn) {
    if (btn) btn.disabled = true;
    window.pendingRemovals.add(jobId);

    const cards = document.querySelectorAll(`.video-card[data-id="${jobId}"]`);
    cards.forEach(card => card.classList.add('removing'));

    try {
        const res = await fetch(`/api/queue/${jobId}/cancel`, { method: 'POST' });
        if (res.ok) {
            showToast('Download cancelled', 'info');
            setTimeout(updateQueue, 300);
        } else {
            window.pendingRemovals.delete(jobId);
            cards.forEach(card => card.classList.remove('removing'));
            showToast('Failed to cancel', 'error');
        }
    } catch (e) {
        window.pendingRemovals.delete(jobId);
        cards.forEach(card => card.classList.remove('removing'));
        showToast('Error cancelling', 'error');
    }
};

window.openJobFolder = async function (jobId) {
    try {
        await fetch(`/api/queue/${jobId}/open`, { method: 'POST' });
    } catch (e) { showToast('Error opening file', 'error'); }
};



function renderQueue(jobs) {
    const grid = document.getElementById('queueGrid');

    // Filter Logic
    let filtered = jobs.filter(job => {
        // Exclude items that are currently being removed/cancelled
        if (window.pendingRemovals.has(job.id)) return false;

        // Strict Separation: Only show in Home/Downloads if the flag is set
        if (job.is_in_downloads == 0 || job.is_in_downloads === false) return false;

        // Page-Level Filter
        if (currentPage === 'Home') {
            // Include 'error' so users see immediate failures
            const isActive = job.status === 'downloading' || job.status === 'queued' || job.status === 'verifying' || job.status === 'error' || job.status === 'detected';
            // Allow completed jobs only if explicitly filtering for them
            if (!isActive && currentFilter !== 'completed') return false;
        } else if (currentPage === 'Downloads') {
            if (job.status !== 'completed' && job.status !== 'error' && job.status !== 'canceled') return false;
        }

        // Search
        if (currentSearch) {
            const title = (job.title || "").toLowerCase();
            const filename = (job.filename || "").toLowerCase();
            if (!title.includes(currentSearch) && !filename.includes(currentSearch)) return false;
        }
        // Filter Chips
        if (currentFilter !== 'all') {
            if (currentFilter === 'downloading') {
                if (job.status !== 'downloading' && job.status !== 'queued' && job.status !== 'verifying') return false;
            }
            else if (job.status !== currentFilter) return false;
        }
        return true;
    });

    // Sort Logic
    filtered.sort((a, b) => {
        if (currentSort === 'newest') return b.timestamp_start - a.timestamp_start;
        if (currentSort === 'oldest') return a.timestamp_start - b.timestamp_start;
        if (currentSort === 'az') return (a.title || "").localeCompare(b.title || "");
        if (currentSort === 'za') return (b.title || "").localeCompare(a.title || "");
        return 0;
    });

    if (filtered.length === 0) {
        grid.innerHTML = '';
        return;
    }


    // Generate Cards
    grid.innerHTML = filtered.map(job => {
        const isDownloading = job.status === 'downloading';
        const isCompleted = job.status === 'completed';
        const isQueued = job.status === 'queued';
        const isCanceled = job.status === 'canceled';
        const isError = job.status === 'error';

        const isDetected = job.status === 'detected';

        let actionsHtml = '';
        const isSelected = window.selectedJobs && window.selectedJobs.includes(job.id);
        const inLibrary = job.is_in_library == 1 || job.is_in_library === true;

        if (isDownloading || isQueued) {
            actionsHtml += `<button class="btn-card-action" onclick="cancelJob('${job.id}', this); event.stopPropagation()" title="Cancel"><span class="material-icons">cancel</span></button>`;
        } else if (isDetected) {
            actionsHtml += `<button class="btn-card-action primary" onclick="startDownload('${job.id}', this, true); event.stopPropagation()" title="Download Now"><span class="material-icons">cloud_download</span></button>`;
            actionsHtml += `<button class="btn-card-action danger" onclick="deleteVideo('${job.id}', '${currentPage.toLowerCase()}'); event.stopPropagation()" title="Remove"><span class="material-icons">delete</span></button>`;
        } else {
            actionsHtml += `<button class="btn-card-action danger" onclick="deleteVideo('${job.id}', '${currentPage.toLowerCase()}'); event.stopPropagation()" title="Remove"><span class="material-icons">delete</span></button>`;
        }

        if (isCompleted) {
            if (inLibrary) {
                actionsHtml += `
                <button class="btn-card-action danger" onclick="deleteVideo('${job.id}', 'library'); event.stopPropagation()" title="Remove from Library"><span class="material-icons" style="color:var(--accent)">bookmark_remove</span></button>
                `;
            } else {
                actionsHtml += `
                <button class="btn-card-action" onclick="window.moveToLibrary(['${job.id}']); event.stopPropagation()" title="Move to Library"><span class="material-icons">bookmark_add</span></button>
                `;
            }
            actionsHtml += `
            <button class="btn-card-action" onclick="window.openJobFolder('${job.id}'); event.stopPropagation()" title="Open File"><span class="material-icons">folder</span></button>
            `;
        }

        const filename = job.filename ? job.filename.split(/[/\\]/).pop() : '';

        return `
                <div class="video-card selectable entrance-anim ${isCompleted ? 'video-card-completed' : ''} ${isSelected ? 'selected' : ''}" 
                     data-id="${job.id}" data-status="${job.status}" data-filename="${filename}"
                     onclick="toggleSelection('${job.id}', event)">
                <div class="card-thumb-container" onclick="if('${isCompleted}' === 'true') { openPlayer(this.closest('.video-card')); event.stopPropagation(); }">
                    ${job.thumbnail ?
                `<img src="${job.thumbnail}" class="card-thumb" alt="${job.title}">` :
                `<div style="width:100%; height:100%; background: linear-gradient(45deg, #1e1e1e, #2a2a2a); display:flex; align-items:center; justify-content:center;">
                             <span class="material-icons" style="font-size:48px; color:rgba(255,255,255,0.1)">play_circle</span>
                          </div>`
            }
                    
                    ${!isCompleted ? `
                    <div class="card-progress-overlay">
                        <div class="card-progress-bar" style="width: ${job.progress}%"></div>
                    </div>` : ''}
                    
                    ${isCompleted ? `<div class="video-preview-overlay" data-job-id="${job.id}"></div>` : ''}
                    ${isCompleted ? `<div class="play-icon-hint"><span class="material-icons">play_circle</span></div>` : ''}
                </div>
                
                <div class="card-body">
                    <h4 class="card-title" title="${job.title}">${job.title}</h4>
                    
                    <div class="card-footer">
                        <div class="card-meta">
                            ${job.status === 'downloading'
                ? '<span class="status-icon-downloading material-icons">autorenew</span>'
                : (job.status === 'completed' ? '' : `<span class="status-badge status-${job.status}">${job.status}</span>`)}
                            ${inLibrary ? '<span class="library-badge"><span class="material-icons" style="font-size: 11px; margin-right: 2px;">bookmark</span>LIBRARY</span>' : ''}
                            <span class="meta-percent">${(job.progress > 0 && !isCompleted) ? Math.round(job.progress) + '%' : ''}</span>
                            ${isDownloading ? `<span class="meta-speed">${job.speed}</span>` : ''}
                            ${(isDownloading && job.eta && job.eta !== 'N/A') ? `<span class="meta-eta">ETA: ${job.eta}</span>` : ''}
                        </div>
                        
                        <div class="card-body-actions">
                            ${actionsHtml}
                        </div>
                    </div>
                </div>
            </div>
                `;
    }).join('');

    // Add video preview hover listeners
    attachVideoPreviewListeners();

    // visual feedback for buttons
    checkActiveStatus(globalJobs);
}

function checkActiveStatus(jobs) {
    const downloadingCount = jobs.filter(j => j.status === 'downloading').length;
    const downloadBtn = document.querySelector('button[data-filter="downloading"]');

    if (downloadBtn) {
        if (downloadingCount > 0) {
            downloadBtn.classList.add('flash-active');
            // Optional: update text with count? "Downloading (2)"
            // downloadBtn.textContent = `Downloading (${downloadingCount})`;
        } else {
            downloadBtn.classList.remove('flash-active');
            // downloadBtn.textContent = 'Downloading';
        }
    }
}

function renderSkeletons(count = 3) {
    const grid = document.getElementById('queueGrid');
    if (!grid) return;

    // Only render if empty to avoid flashing over existing content
    if (grid.children.length > 0 && !grid.querySelector('.empty-placeholder')) return;

    let html = '';
    for (let i = 0; i < count; i++) {
        html += `
                <div class="video-card skeleton-card">
            <div class="skeleton-thumb skeleton"></div>
            <div class="skeleton-body">
                <div class="skeleton-text skeleton"></div>
                <div class="skeleton-text short skeleton"></div>
            </div>
        </div>
                `;
    }
    grid.innerHTML = html;
}

// Helper Functions for Actions


// Video Preview on Hover
function attachVideoPreviewListeners() {
    const completedCards = document.querySelectorAll('.video-card-completed');

    completedCards.forEach(card => {
        const container = card.querySelector('.card-thumb-container');
        const thumbnail = card.querySelector('.card-thumb');
        const previewOverlay = card.querySelector('.video-preview-overlay');
        const playHint = card.querySelector('.play-icon-hint');
        const jobId = card.dataset.id;

        if (!container || !previewOverlay) {
            return;
        }

        if (container.classList.contains('preview-attached')) return;
        container.classList.add('preview-attached');

        let videoElement = null;
        let hoverTimeout = null;

        container.addEventListener('mouseenter', () => {
            // Delay preview slightly to avoid accidental triggers
            hoverTimeout = setTimeout(() => {
                // Create video element
                videoElement = document.createElement('video');
                videoElement.className = 'video-preview-player';
                videoElement.src = `/api/stream/${jobId}`;
                videoElement.muted = true;
                videoElement.loop = true;
                videoElement.preload = 'metadata';

                // Insert video into overlay
                previewOverlay.appendChild(videoElement);

                // Play video
                videoElement.play().catch(err => {
                    // Silent catch for autoplay restrictions
                });

                // Hide thumbnail and play hint
                if (thumbnail) thumbnail.style.opacity = '0';
                if (playHint) playHint.style.opacity = '0';

                // Show overlay with fade
                previewOverlay.style.opacity = '1';
            }, 300); // 300ms delay before showing preview
        });

        container.addEventListener('mouseleave', () => {
            console.log(`[HOVER DEBUG] Mouse leave on ${jobId} `);
            // Clear timeout if mouse leaves before preview shows
            if (hoverTimeout) {
                clearTimeout(hoverTimeout);
                hoverTimeout = null;
            }

            // Hide and cleanup video
            if (videoElement) {
                videoElement.pause();
                previewOverlay.style.opacity = '0';

                // Remove video after fade transition
                setTimeout(() => {
                    if (videoElement && videoElement.parentNode) {
                        videoElement.remove();
                        videoElement = null;
                    }
                }, 300);
            }

            // Show thumbnail and play hint again
            if (thumbnail) thumbnail.style.opacity = '1';
            if (playHint) playHint.style.opacity = '1';
        });
    });
}

// Navigation
// Navigation
const navLinks = document.querySelectorAll('.nav-links li a');
const sections = {
    'Home': { show: ['.hero-section', '#downloadsSection'], hide: ['#librarySection', '#settingsSection', '#subscriptionsSection', '#systemSection', '#convertSection'] },
    'Library': { show: ['#librarySection'], hide: ['.hero-section', '#downloadsSection', '#settingsSection', '#subscriptionsSection', '#systemSection', '#videoPreview', '#convertSection'] },
    'Downloads': { show: ['#downloadsSection'], hide: ['.hero-section', '#librarySection', '#settingsSection', '#subscriptionsSection', '#systemSection', '#videoPreview', '#convertSection'] },
    'Subscriptions': { show: ['#subscriptionsSection'], hide: ['.hero-section', '#librarySection', '#downloadsSection', '#settingsSection', '#videoPreview', '#systemSection', '#convertSection'] },
    'Settings': { show: ['#settingsSection'], hide: ['.hero-section', '#librarySection', '#downloadsSection', '#videoPreview', '#subscriptionsSection', '#systemSection', '#convertSection'] },
    'System': { show: ['#systemSection'], hide: ['.hero-section', '#librarySection', '#downloadsSection', '#settingsSection', '#subscriptionsSection', '#videoPreview', '#convertSection'] },
    'Convert': { show: ['#convertSection'], hide: ['.hero-section', '#librarySection', '#downloadsSection', '#settingsSection', '#subscriptionsSection', '#videoPreview', '#systemSection'] }
};

// --- Convert Feature Logic ---
document.addEventListener('DOMContentLoaded', () => {
    const uploadZone = document.getElementById('uploadZone');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const removeFileBtn = document.getElementById('removeFileBtn');
    const startConvertBtn = document.getElementById('startConvertBtn');
    const convertFormat = document.getElementById('convertFormat');
    const convertProgress = document.getElementById('convertProgress');
    const convertProgressBar = document.getElementById('convertProgressBar');
    const convertStatusText = document.getElementById('convertStatusText');
    const convertPercent = document.getElementById('convertPercent');
    const convertResult = document.getElementById('convertResult');
    const convertNewBtn = document.getElementById('convertNewBtn'); // Ensure this is defined
    let currentConvertFile = null;

    if (uploadZone) {
        uploadZone.addEventListener('click', () => fileInput.click());

        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            uploadZone.classList.add('dragover');
        });

        uploadZone.addEventListener('dragleave', () => {
            uploadZone.classList.remove('dragover');
        });

        uploadZone.addEventListener('drop', (e) => {
            e.preventDefault();
            uploadZone.classList.remove('dragover');
            const files = e.dataTransfer.files;
            if (files.length) handleVerifyUpload(files[0]);
        });

        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length) {
                handleVerifyUpload(e.target.files[0]);
            }
        });
    }

    if (removeFileBtn) {
        removeFileBtn.addEventListener('click', resetConvertUI);
    }

    // Explicitly attach reset to new button if exists
    if (convertNewBtn) {
        convertNewBtn.addEventListener('click', resetConvertUI);
    }

    function handleVerifyUpload(file) {
        // Simple client-side check
        // allow more formats
        // if (!file.type.startsWith('video/')) { ... } 
        // Relaxation: accept all for now, or check extensions

        currentConvertFile = file;
        fileName.textContent = file.name;

        uploadZone.classList.add('hidden');
        fileInfo.classList.remove('hidden');
        startConvertBtn.disabled = false;
    }

    if (startConvertBtn) {
        startConvertBtn.addEventListener('click', async () => {
            if (!currentConvertFile) {
                showToast("No file selected!", "error");
                return;
            }

            // UI State: Uploading
            startConvertBtn.disabled = true;
            startConvertBtn.disabled = true;
            let originalBtnText = startConvertBtn.innerHTML;

            // Show Progress UI IMMEDIATELY
            document.querySelector('.convert-controls').classList.add('hidden');
            convertProgress.classList.remove('hidden');
            document.getElementById('convertStatusText').textContent = "Uploading...";
            document.getElementById('convertPercent').textContent = "0%";
            document.getElementById('convertProgressBar').style.width = "0%";

            try {
                // 1. Upload
                const formData = new FormData();
                formData.append('file', currentConvertFile);

                const uploadRes = await fetch('/api/convert/upload', {
                    method: 'POST',
                    body: formData
                });

                if (!uploadRes.ok) {
                    const errText = await uploadRes.text();
                    throw new Error(`Upload failed: ${uploadRes.status} ${errText}`);
                }
                const uploadData = await uploadRes.json();

                // 2. Start Conversion
                document.getElementById('convertStatusText').textContent = "Starting...";

                const startRes = await fetch('/api/convert/start', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filename: uploadData.filename,
                        format: convertFormat.value
                    })
                });

                if (!startRes.ok) throw new Error("Failed to start conversion");
                const startData = await startRes.json();

                // 3. Poll Status
                pollConversion(startData.job_id);

            } catch (e) {
                console.error("Conversion/Upload Error:", e);
                showToast(e.message, 'error');
                startConvertBtn.disabled = false;
                document.querySelector('.convert-controls').classList.remove('hidden');
                convertProgress.classList.add('hidden');
            }
        });
    } else {
        console.error("startConvertBtn NOT FOUND in DOM");
    }

    // Helper functions inside scope or global if needed?
    // pollConversion needs access to DOM elements which are now local to this scope.
    // So pollConversion should be defined INSIDE this scope.

    async function pollConversion(jobId) {
        const interval = setInterval(async () => {
            try {
                const res = await fetch(`/api/convert/status/${jobId}?t=${Date.now()}`);
                if (!res.ok) return;

                const job = await res.json();
                console.log(`Job Status: ${job.status}, Progress: ${job.progress}`);

                if (job.status === 'processing' || job.status === 'queued') {
                    convertStatusText.textContent = job.status === 'queued' ? 'Queued...' : 'Processing...';

                    // Real Progress from Backend
                    const progress = job.progress || 0;
                    convertProgressBar.style.width = `${progress}%`;
                    convertPercent.textContent = `${Math.round(progress)}%`;

                    // Update status text based on progress
                    if (progress > 98) {
                        convertStatusText.textContent = 'Finalizing...';
                    } else if (progress > 50) {
                        convertStatusText.textContent = 'Converting...';
                    }
                } else if (job.status === 'completed') {
                    clearInterval(interval);
                    convertProgressBar.style.width = '100%';
                    convertPercent.textContent = '100%';
                    convertStatusText.textContent = 'Conversion Complete!';

                    setTimeout(() => {
                        convertProgress.classList.add('hidden');
                        convertResult.classList.remove('hidden');
                        downloadResultBtn.href = `/api/convert/download/${job.output_file}`;
                    }, 500);
                } else if (job.status === 'error') {
                    clearInterval(interval);
                    showToast(`Conversion failed: ${job.error}`, 'error');
                    resetConvertUI();
                }
            } catch (e) {
                console.error("Poll error", e);
            }
        }, 1000);
    }

    // resetConvertUI also needs access to these vars
    function resetConvertUI() {
        currentConvertFile = null;
        uploadZone.classList.remove('hidden');
        fileInfo.classList.add('hidden');
        convertProgress.classList.add('hidden');
        convertResult.classList.add('hidden');
        document.querySelector('.convert-controls').classList.remove('hidden');
        startConvertBtn.disabled = true;
        startConvertBtn.innerHTML = '<span class="material-icons">transform</span> Start Conversion';
        fileName.textContent = '';
        if (fileInput) fileInput.value = '';
    }
});


let currentPage = 'Home'; // Track current page

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        // Remove active class
        document.querySelectorAll('.nav-links li').forEach(li => li.classList.remove('active'));
        const li = link.parentElement;
        li.classList.add('active');

        const page = link.dataset.page;
        if (page) handleNav(page);
    });
});

async function handleNav(pageName) {
    if (currentPage === pageName) return;

    // 1. Identify OUTGOING sections (everything currently visible)
    // We look at the PREVIOUS page's config to know what to hide
    const prevConfig = sections[currentPage] || sections['Home'];
    const outgoingSelectors = prevConfig.show; // These are currently shown

    // 2. Identify INCOMING sections
    const nextConfig = sections[pageName] || sections['Home'];

    // START TRANSITION OUT
    outgoingSelectors.forEach(selector => {
        const els = document.querySelectorAll(selector);
        els.forEach(el => {
            el.classList.add('section-exit');
            // Force reflow
            void el.offsetWidth;
            el.classList.add('section-exit-active');
        });
    });

    // Update State
    currentPage = pageName;

    // WAIT for exit animation (300ms match css)
    await new Promise(r => setTimeout(r, 200));

    // HIDE OUTGOING (Apply .hidden)
    outgoingSelectors.forEach(selector => {
        const els = document.querySelectorAll(selector);
        els.forEach(el => {
            el.classList.add('hidden');
            el.classList.remove('section-exit', 'section-exit-active');
        });
    });

    // Custom Logic (Title update)
    if (pageName === 'Settings') loadSettings();
    else if (pageName === 'Subscriptions') loadSubscriptions();
    else if (pageName === 'System') loadLogs();
    else if (pageName === 'Library') loadLibrary();

    // Reset search/filter state on navigation to keep sections clean
    currentSearch = '';
    currentFilter = 'all';
    const searchInput = document.getElementById('dashboardSearch');
    if (searchInput) searchInput.value = '';
    const chips = document.querySelectorAll('.chip');
    chips.forEach(c => c.classList.toggle('active', c.dataset.filter === 'all'));

    const sectionTitle = document.querySelector('#downloadsSection .section-title h3');
    const clearBtn = document.getElementById('toolbarClearBtn');
    const selectAllBtn = document.getElementById('selectAllBtn');

    // UI Updates before showing
    // UI Updates before showing
    if (pageName === 'Home') {
        if (sectionTitle) sectionTitle.innerHTML = '<span class="material-icons" style="font-size: 32px; color: var(--primary); vertical-align: middle; margin-right: 8px;">download_for_offline</span> Active Downloads';
        updateClearButtonVisibility(); // Conditional show
        if (selectAllBtn) selectAllBtn.style.display = 'flex';

        // Show Queue Search/Filter only in Home section
        const toolbar = document.getElementById('dashboardToolbar');
        if (toolbar) toolbar.style.display = 'flex';

    } else if (pageName === 'Downloads') {
        if (sectionTitle) sectionTitle.innerHTML = '<span class="material-icons" style="font-size: 32px; color: var(--accent); vertical-align: middle; margin-right: 8px;">history</span> Download History';
        updateClearButtonVisibility(); // Conditional show
        if (selectAllBtn) selectAllBtn.style.display = 'none';
        // Hide toolbar in Downloads as per user request ("Home is the only section")
        const toolbar = document.getElementById('dashboardToolbar');
        if (toolbar) toolbar.style.display = 'none';
    } else {
        // Hide toolbar on non-queue pages
        const toolbar = document.getElementById('dashboardToolbar');
        if (toolbar) toolbar.style.display = 'none';

        // Hide clear button on other pages
        if (clearBtn) clearBtn.style.display = 'none';
    }

    // Reset selection bar when changing pages
    window.selectedJobs = [];
    updateBulkBar();

    // SHOW INCOMING
    nextConfig.show.forEach(selector => {
        const els = document.querySelectorAll(selector);
        els.forEach(el => {
            el.classList.remove('hidden');
            el.classList.add('section-enter');
            // Force reflow
            void el.offsetWidth;
            el.classList.add('section-enter-active');

            // Cleanup classes after animation
            setTimeout(() => {
                el.classList.remove('section-enter', 'section-enter-active');
            }, 300);
        });
    });

    // Refresh Data if needed
    if (pageName === 'Home' || pageName === 'Downloads') {
        renderQueue(globalJobs);
    }
}

// Settings Logic
async function loadSettings() {
    try {
        const res = await fetch('/api/settings');
        const data = await res.json();
        document.getElementById('settingDownloadDir').value = data.download_dir;
        document.getElementById('settingDefaultFormat').value = data.default_format;
        document.getElementById('settingTheme').value = data.theme;
        document.getElementById('settingTheme').value = data.theme;
        document.getElementById('settingAutoStart').checked = data.auto_start_queue;
        document.getElementById('settingEnableRegistration').checked = data.enable_registration;

        // Show System Logs (default true if not set)
        const showSystemLogs = data.show_system_logs !== undefined ? data.show_system_logs : true;
        document.getElementById('settingShowSystemLogs').checked = showSystemLogs;
        applySystemLogsVisibility(showSystemLogs);


        // Advanced
        document.getElementById('settingFilenameTemplate').value = data.filename_template || "%(title)s.%(ext)s";
        document.getElementById('settingCookiesPath').value = data.cookies_path || "";
        document.getElementById('settingCookiesBrowser').value = data.cookies_browser || "";
        document.getElementById('settingCustomArgs').value = data.custom_args || "";
        document.getElementById('settingMaxConcurrent').value = data.max_concurrent_downloads || 3;
        document.getElementById('settingMaxRetries').value = data.max_retries || 3;

        // Load logs if Settings page is active (or just load them)
        loadLogs();

        // Apply theme
        applyTheme(data.theme);
    } catch (e) { console.error(e); }
}

function applyTheme(theme) {
    if (theme === 'light') {
        document.body.classList.add('light-theme');
        localStorage.setItem('theme', 'light');
        document.cookie = "theme=light; path=/; max-age=31536000";
    } else {
        document.body.classList.remove('light-theme');
        localStorage.setItem('theme', 'dark');
        document.cookie = "theme=dark; path=/; max-age=31536000";
    }
}

async function loadLogs() {
    const container = document.getElementById('logsContainer');
    try {
        const res = await fetch('/api/logs');
        if (!res.ok) return;
        const logs = await res.json();

        if (logs.length === 0) {
            container.innerHTML = '<p style="color: grey">No logs found.</p>';
            return;
        }

        container.innerHTML = logs.map(log => {
            const time = new Date(log.timestamp).toLocaleTimeString();
            let levelClass = 'log-info';
            if (log.level === 'ERROR') levelClass = 'log-error';
            if (log.level === 'WARNING') levelClass = 'log-warn';
            return `<div class="log-entry" style="font-size:12px; margin-bottom:4px;">
                <span class="log-timestamp">[${time}]</span>&nbsp;
                <span class="${levelClass}" style="font-weight:bold;">${log.level}</span>
                <span class="log-source">(${log.source}):</span> ${log.message}
            </div>`;
        }).join('');

        // Auto-scroll feature
        const autoScroll = document.getElementById('autoRefreshLogs');
        if (autoScroll && autoScroll.checked) {
            container.scrollTop = container.scrollHeight;
        }
    } catch (e) {
        container.innerHTML = '<p style="color: red">Failed to load logs.</p>';
    }
}

// Toast Notification (Global)
window.showToast = function (message, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        <span class="material-icons">${type === 'success' ? 'check_circle' : type === 'error' ? 'error' : 'info'}</span>
        <span>${message}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s forwards';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
};

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    console.log("[Dashboard] Initializing v29.1...");

    // Refresh Logs Logic
    const refreshLogsBtn = document.getElementById('refreshLogsBtn');
    if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', loadLogs);

    // Auto-poll logs when System tab active and Auto-scroll checked
    setInterval(() => {
        const autoScroll = document.getElementById('autoRefreshLogs');
        if (currentPage === 'System' && autoScroll && autoScroll.checked) {
            loadLogs();
        }
    }, 2000);

    // Load config
    loadSettings();
    setupSystemTabs();

    const saveSettingsBtn = document.getElementById('saveSettingsBtn');
    if (saveSettingsBtn) {
        saveSettingsBtn.addEventListener('click', async () => {
            // Remove native confirm, use button state instead
            const originalContent = saveSettingsBtn.innerHTML;

            // Set Loading State
            saveSettingsBtn.classList.add('loading');
            saveSettingsBtn.innerHTML = '<span class="material-icons spin" style="font-size: 16px;">sync</span> Saving...';

            // Collect Settings
            const settings = {
                download_dir: document.getElementById('settingDownloadDir').value,
                default_format: document.getElementById('settingDefaultFormat').value,
                theme: document.getElementById('settingTheme').value,
                filename_template: document.getElementById('settingFilenameTemplate').value,
                cookies_path: document.getElementById('settingCookiesPath').value,
                cookies_browser: document.getElementById('settingCookiesBrowser').value,
                custom_args: document.getElementById('settingCustomArgs').value,
                auto_start_queue: document.getElementById('settingAutoStart').checked,
                show_system_logs: document.getElementById('settingShowSystemLogs').checked,
                enable_registration: document.getElementById('settingEnableRegistration').checked,

                max_concurrent_downloads: parseInt(document.getElementById('settingMaxConcurrent').value) || 3,
                max_retries: parseInt(document.getElementById('settingMaxRetries').value) || 3
            };

            try {
                // Minimum delay for visual feedback (500ms)
                const [res] = await Promise.all([
                    fetch('/api/settings', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(settings)
                    }),
                    new Promise(r => setTimeout(r, 600))
                ]);

                if (res.ok) {
                    showToast('Settings Saved', 'success');
                    applyTheme(settings.theme);
                    // Success State briefly?
                    saveSettingsBtn.innerHTML = '<span class="material-icons" style="font-size: 16px;">check</span> Saved';
                    setTimeout(() => {
                        saveSettingsBtn.classList.remove('loading');
                        saveSettingsBtn.innerHTML = originalContent;
                    }, 1000);
                } else {
                    throw new Error('Save failed');
                }
            } catch (e) {
                showToast('Failed to save settings', 'error');
                saveSettingsBtn.classList.remove('loading');
                saveSettingsBtn.innerHTML = originalContent;
            }
        });

        // Live Preview for Theme
        const themeSelect = document.getElementById('settingTheme');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                applyTheme(e.target.value);
            });
        }
    }

    // Video Player Logic
    const videoModal = document.getElementById('videoModal');
    const mainPlayer = document.getElementById('mainPlayer');
    const closePlayerBtn = document.getElementById('closePlayerBtn');

    if (closePlayerBtn) {
        closePlayerBtn.addEventListener('click', () => {
            videoModal.classList.add('hidden');
            if (window.player) window.player.stop();
            mainPlayer.src = "";
        });
    }

    // Close on click outside
    window.addEventListener('click', (e) => {
        if (e.target === videoModal) {
            videoModal.classList.add('hidden');
            if (window.player) window.player.stop();
            mainPlayer.src = "";
        }
    });

    // Grid Click Logic (Subscriptions)
    const grids = [document.getElementById('subsGrid')];
    console.log('[PLAYER DEBUG] Attaching listeners to grids:', grids.filter(g => g).length);
    grids.forEach(grid => {
        if (grid) {
            grid.addEventListener('click', (e) => {
                console.log('[PLAYER DEBUG] Grid clicked, target:', e.target);
                // If clicked on actions, ignore
                if (e.target.closest('.card-actions')) {
                    console.log('[PLAYER DEBUG] Clicked on actions, ignoring');
                    return;
                }
                const card = e.target.closest('.video-card');
                console.log('[PLAYER DEBUG] Card found:', card);
                if (card) {
                    console.log('[PLAYER DEBUG] Opening player for card:', card.dataset.id);
                    openPlayer(card);
                }
            });
        }
    });

    // Add Sub Modal Logic
    const addSubBtn = document.getElementById('addSubBtn');
    const addSubModal = document.getElementById('addSubModal');
    const closeAddSubBtn = document.getElementById('closeAddSubBtn');
    const cancelAddSubBtn = document.getElementById('cancelAddSubBtn');
    const confirmAddSubBtn = document.getElementById('confirmAddSubBtn');
    const subUrlInput = document.getElementById('subUrlInput');

    if (addSubBtn) {
        addSubBtn.addEventListener('click', () => {
            addSubModal.classList.remove('hidden');
            subUrlInput.focus();
        });
    }

    function closeAddSub() {
        addSubModal.classList.add('hidden');
        subUrlInput.value = '';
    }

    if (closeAddSubBtn) closeAddSubBtn.addEventListener('click', closeAddSub);
    if (cancelAddSubBtn) cancelAddSubBtn.addEventListener('click', closeAddSub);

    if (confirmAddSubBtn) {
        confirmAddSubBtn.addEventListener('click', async () => {
            const url = subUrlInput.value.trim();
            if (!url) return;

            // Premium Fields
            const autoDownload = document.getElementById('subAutoDownload').checked;
            const filterKeywords = document.getElementById('subFilterInput').value.trim();

            confirmAddSubBtn.disabled = true;
            confirmAddSubBtn.innerHTML = '<span class="material-icons spin">refresh</span> Fetching Info...';

            try {
                const res = await fetch('/api/subscriptions', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url,
                        auto_download: autoDownload,
                        filter_keywords: filterKeywords
                    })
                });

                if (res.ok) {
                    showToast("Subscription added! Fetching videos...", "success");
                    closeAddSub();
                    loadSubscriptions(); // Refresh list
                } else {
                    const err = await res.json();
                    showToast(err.detail || "Failed to add", "error");
                }
            } catch (e) {
                showToast("Error adding subscription", "error");
            } finally {
                confirmAddSubBtn.disabled = false;
                confirmAddSubBtn.textContent = "Add Subscription";
            }
        });
    }

    // System Tasks Logic
    // System Tasks Logic - Premium Update UI
    const updateStatusContainer = document.getElementById('updateStatusContainer');

    // Function to render status cards
    function renderUpdateStatus(state, data = {}) {
        if (!updateStatusContainer) return;

        let html = '';
        const currentVer = data.current_version || 'Unknown';
        const newVer = data.new_version || data.current_version;

        if (state === 'LOADING' || state === 'CHECKING') {
            html = `
                <div class="status-label">
                    <span class="material-icons" style="font-size: 16px; opacity: 0.6;">update</span>
                    <span>Core Engine</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div class="version-display" style="opacity: 0.5;">Checking...</div>
                    <button class="btn-icon-glass" style="width: 32px; height: 32px;">
                        <span class="material-icons spin-animation" style="font-size: 16px;">sync</span>
                    </button>
                </div>`;
        } else if (state === 'UP_TO_DATE') {
            html = `
                <div class="status-label">
                    <span class="material-icons" style="font-size: 16px; opacity: 0.6;">update</span>
                    <span>Core Engine</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div class="version-display">${currentVer}</div>
                    <button id="checkUpdateBtn" class="btn-icon-glass" title="Check Again" style="width: 32px; height: 32px;">
                        <span class="material-icons" style="font-size: 16px;">refresh</span>
                    </button>
                </div>`;
        } else if (state === 'UPDATED') {
            html = `
                <div class="status-label">
                    <span class="material-icons" style="font-size: 16px; opacity: 0.6;">update</span>
                    <span>Core Engine</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div class="version-display" style="color: #34d399; border-color: rgba(52, 211, 153, 0.3);">${newVer}</div>
                    <button id="checkUpdateBtn" class="btn-icon-glass" title="Updated" style="width: 32px; height: 32px;">
                        <span class="material-icons" style="font-size: 16px; color: #34d399;">check</span>
                    </button>
                </div>`;
        } else if (state === 'ERROR') {
            html = `
                <div class="status-label">
                    <span class="material-icons" style="font-size: 16px; opacity: 0.6;">update</span>
                    <span>Core Engine</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <div class="version-display" style="color: #f87171; border-color: rgba(248, 113, 113, 0.3);">Failed</div>
                    <button id="checkUpdateBtn" class="btn-icon-glass" title="Retry" style="width: 32px; height: 32px;">
                        <span class="material-icons" style="font-size: 16px;">refresh</span>
                    </button>
                </div>`;
        }

        updateStatusContainer.innerHTML = html;

        // Re-attach listener to dynamic button
        const checkBtn = document.getElementById('checkUpdateBtn');
        if (checkBtn) {
            checkBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                triggerUpdate();
            });
        }
    }

    async function triggerUpdate() {
        renderUpdateStatus('CHECKING', { current_version: '...' });
        try {
            const res = await fetch('/api/system/update-ytdlp', { method: 'POST' });
            const data = await res.json();

            if (data.status === 'success') {
                if (data.output.includes('Requirement already satisfied') || data.current_version === data.new_version) {
                    renderUpdateStatus('UP_TO_DATE', data);
                } else {
                    renderUpdateStatus('UPDATED', data);
                }
            } else {
                renderUpdateStatus('ERROR', data);
            }
        } catch (e) {
            renderUpdateStatus('ERROR', { output: e.message });
        }
    }

    // Auto-check on system tab load
    if (updateStatusContainer) {
        // Initial state
        renderUpdateStatus('LOADING');
        // Trigger check
        triggerUpdate();
    }

    // Clear Completed Downloads Handler
    const clearCompletedBtn = document.getElementById('clearCompletedBtn');
    if (clearCompletedBtn) {
        clearCompletedBtn.addEventListener('click', async () => {
            if (!confirm("Clear all completed downloads from history?")) return;
            const originalText = clearCompletedBtn.innerHTML;
            clearCompletedBtn.innerHTML = '<span class="material-icons spin-animation" style="font-size: 16px;">refresh</span> Clearing...';
            clearCompletedBtn.disabled = true;
            try {
                await fetch('/api/system/clear-completed', { method: 'POST' });
                showToast("Completed downloads cleared", "success");
                setTimeout(() => updateQueue(), 300);
            } catch (e) {
                showToast("Failed to clear", "error");
            } finally {
                clearCompletedBtn.innerHTML = originalText;
                clearCompletedBtn.disabled = false;
            }
        });
    }

    const clearFailedBtn = document.getElementById('clearFailedBtn');
    if (clearFailedBtn) {
        clearFailedBtn.addEventListener('click', async () => {
            if (!confirm("Clear all failed and canceled jobs?")) return;
            const originalText = clearFailedBtn.innerHTML;
            clearFailedBtn.innerHTML = '<span class="material-icons spin" style="font-size: 16px;">refresh</span> Clearing...';
            clearFailedBtn.disabled = true;
            try {
                await fetch('/api/system/clear-failed', { method: 'POST' });
                showToast("Failed jobs cleared", "success");
                setTimeout(() => updateQueue(), 300);
            } catch (e) {
                showToast("Failed to clear", "error");
            } finally {
                clearFailedBtn.innerHTML = originalText;
                clearFailedBtn.disabled = false;
            }
        });
    }


    // Cancel Preview Handler
    const cancelBtn = document.getElementById('cancelPreviewBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            const previewSection = document.getElementById('videoPreview');
            previewSection.classList.add('hidden');
            const urlInput = document.getElementById('urlInput');
            if (urlInput) urlInput.value = '';
        });
    }

    // Clear All Toolbar Button
    const toolbarClearBtn = document.getElementById('toolbarClearBtn');
    if (toolbarClearBtn) {
        toolbarClearBtn.addEventListener('click', async () => {
            console.log('[DEBUG] Clear All clicked');
            if (!confirm("Clear all completed and failed downloads?")) return;

            console.log('[DEBUG] Confirmed. Clearing...');
            const originalText = toolbarClearBtn.innerHTML;
            toolbarClearBtn.innerHTML = '<span class="material-icons spin-animation">refresh</span> Clearing...';
            toolbarClearBtn.disabled = true;

            try {
                const res = await fetch('/api/system/clear-queue', {
                    method: 'POST',
                    credentials: 'include'
                });
                const data = await res.json();

                if (data.status === 'cleared') {
                    showToast('Download history cleared', 'success');
                    setTimeout(() => updateQueue(), 300);
                } else {
                    showToast('Failed to clear history', 'error');
                }
            } catch (err) {
                console.error(err);
                showToast('Error clearing history', 'error');
            } finally {
                toolbarClearBtn.innerHTML = originalText;
                toolbarClearBtn.disabled = false;
            }
        });
    }

    // Toggle Log Console
    const toggleLogsBtn = document.getElementById('toggleLogsBtn');
    const toggleLogsText = document.getElementById('toggleLogsText');
    const logsWrapper = document.getElementById('logsWrapper');

    if (toggleLogsBtn) {
        toggleLogsBtn.addEventListener('click', () => {
            logsWrapper.classList.toggle('hidden');
            const isHidden = logsWrapper.classList.contains('hidden');
            toggleLogsText.textContent = isHidden ? "Show Console" : "Hide Console";

            if (!isHidden) {
                loadLogs(); // Assuming refetch is desired
            }
        });
    }

    // Force UI state sync on load
    handleNav(currentPage);

    // Bulk Actions Setup - Legacy btn listener removed, logic moved to toggleSelectAll()
    // const selectAllBtn = document.getElementById('selectAllBtn');

    const bulkMoveBtn = document.getElementById('bulkMoveBtn');
    if (bulkMoveBtn) {
        bulkMoveBtn.addEventListener('click', () => {
            window.moveToLibrary(window.selectedJobs);
        });
    }

    const bulkCancelBtn = document.getElementById('bulkCancelBtn');
    if (bulkCancelBtn) {
        bulkCancelBtn.addEventListener('click', () => {
            window.selectedJobs = [];
            document.querySelectorAll('.video-card.selected').forEach(c => c.classList.remove('selected'));
            updateBulkBar();
        });
    }

    const bulkDeleteBtn = document.getElementById('bulkDeleteBtn');
    if (bulkDeleteBtn) {
        bulkDeleteBtn.addEventListener('click', () => {
            window.bulkDeleteVideos(window.selectedJobs);
        });
    }
});

// Video Player Helper
function openPlayer(card) {
    console.log('[PLAYER DEBUG] openPlayer called with card:', card);
    const jobId = card.dataset.id;

    // Navigate to the full player page, forcing it to play immediately since the user explicitly clicked the video
    window.location.href = `/player/${jobId}?autoplay=1`;
}

// --- Subscription Logic ---

async function loadSubscriptions() {
    const grid = document.getElementById('subsGrid');
    if (!grid) return;

    // Show loading skeleton if empty
    if (grid.innerHTML.trim() === '') {
        grid.innerHTML = '<div style="padding:20px; text-align:center; color:#888;">Loading subscriptions...</div>';
    }

    try {
        const res = await fetch('/api/subscriptions');
        const subs = await res.json();
        renderSubscriptions(subs);
    } catch (e) {
        console.error(e);
        grid.innerHTML = '<p class="error-text">Failed to load subscriptions</p>';
    }
}

function renderSubscriptions(subs) {
    const grid = document.getElementById('subsGrid');
    if (!grid) return;

    if (subs.length === 0) {
        grid.innerHTML = `
                <div class="empty-placeholder">
                <span class="material-icons large-icon" style="opacity:0.3">subscriptions</span>
                <p>No subscriptions yet.</p>
                <button class="btn-contained primary" onclick="document.getElementById('addSubBtn').click()">Add Your First Channel</button>
            </div> `;
        return;
    }

    grid.innerHTML = subs.map(sub => `
                <div class="video-card subscription-card" data-id="${sub.id}">
             <div class="card-thumb-container" style="height: 140px; background: #222;">
                ${sub.avatar_url ?
            `<img src="${sub.avatar_url}" class="card-thumb" style="object-fit: cover;" alt="${sub.name}">` :
            `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.1);">
                        <span class="material-icons" style="font-size:48px;">account_circle</span>
                     </div>`
        }
                
                <div class="card-progress-overlay" style="background: linear-gradient(to top, rgba(0,0,0,0.8), transparent);">
                    <div style="position: absolute; bottom: 8px; left: 12px; display: flex; align-items: center; gap: 6px;">
                        ${sub.auto_download ?
            `<span class="status-badge status-downloading" style="font-size:10px; padding:2px 6px;">
                                <span class="material-icons" style="font-size:12px; margin-right:2px; vertical-align:middle;">cloud_download</span> AUTO
                             </span>` : ''}
                    </div>
                </div>
            </div>
            
            <div class="card-body">
                <h4 class="card-title" title="${sub.name}">${sub.name}</h4>
                <div class="card-meta" style="margin-top: 4px;">
                     <span style="font-size: 11px; color: #888;">
                        <span class="material-icons" style="font-size:12px; vertical-align:middle;">history</span> 
                        Last check: ${sub.last_checked ? new Date(sub.last_checked).toLocaleString() : 'Never'}
                     </span>
                </div>
                
                <div class="card-actions" style="margin-top: 12px; display: flex; gap: 8px; justify-content: flex-end;">
                     <button class="btn-icon-glass" onclick="checkSubscription('${sub.id}', this)" title="Check for new videos">
                        <span class="material-icons" style="font-size:18px;">refresh</span>
                     </button>
                     <button class="btn-icon-glass danger" onclick="deleteSubscription('${sub.id}')" title="Unsubscribe">
                        <span class="material-icons" style="font-size:18px;">delete</span>
                     </button>
                </div>
            </div>
        </div >
                `).join('');
}

window.checkSubscription = async (id, btn) => {
    if (btn) {
        btn.disabled = true;
        btn.textContent = "...";
    }
    showToast('Checking for new videos...', 'info');
    try {
        await fetch(`/ api / subscriptions / ${id}/check`, { method: 'POST' });
        loadSubscriptions(); // Refresh to show new Time and/or new videos
    } catch (e) {
        showToast('Check failed', 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = '<span class="material-icons" style="font-size:18px;">refresh</span>';
        }
    }
};

window.deleteSubscription = async (id) => {
    if (!confirm('Unsubscribe from this channel?')) return;
    try {
        await fetch(`/api/subscriptions/${id}`, { method: 'DELETE' });
        loadSubscriptions();
        showToast('Unsubscribed', 'success');
    } catch (e) {
        showToast('Error removing subscription', 'error');
    }
};

// --- User Management Logic ---

function setupSystemTabs() {
    const tabs = document.querySelectorAll('.sys-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            // Toggle active state
            tabs.forEach(t => {
                t.classList.remove('active');
                // Clean up any legacy inline styles
                t.style.borderBottomColor = '';
                t.style.color = '';
            });
            tab.classList.add('active');

            const target = tab.dataset.tab;
            const dashboardView = document.getElementById('sysDashboardView');
            const usersView = document.getElementById('sysUsersView');
            const profileView = document.getElementById('sysProfileView');

            // Reset all
            dashboardView.classList.add('hidden');
            usersView.classList.add('hidden');
            if (profileView) profileView.classList.add('hidden');

            if (target === 'dashboard') {
                dashboardView.classList.remove('hidden');
            } else if (target === 'users') {
                usersView.classList.remove('hidden');
                loadUsers();
            } else if (target === 'profile') {
                if (profileView) profileView.classList.remove('hidden');
                loadProfile();
            }
        });
    });

    // Cleaned up redundant modal listeners from setupSystemTabs since they are handled at the bottom of dashboard.js
}

async function loadUsers() {
    const tableBody = document.getElementById('usersTableBody');
    const loading = document.getElementById('usersLoading');

    // Use tableBody instead of grid
    if (tableBody) tableBody.innerHTML = '';
    if (loading) loading.classList.remove('hidden');

    try {
        const res = await fetch('/api/users');
        if (res.status === 403) {
            if (loading) loading.classList.add('hidden');
            if (tableBody) {
                tableBody.innerHTML = `
                <tr>
                    <td colspan="5" style="text-align:center; padding:40px; color:var(--error);">
                        <span class="material-icons large-icon">lock</span>
                        <p>Access Denied</p>
                    </td>
                </tr>`;
            }
            return;
        }

        const users = await res.json();
        renderUsers(users);
    } catch (e) {
        console.error(e);
        if (tableBody) tableBody.innerHTML = '<tr><td colspan="5" class="error-text" style="text-align:center;">Failed to load users</td></tr>';
    } finally {
        if (loading) loading.classList.add('hidden');
    }
}

function renderUsers(users) {
    const tableBody = document.getElementById('usersTableBody');
    if (!tableBody) return;

    if (users.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align:center; color:var(--text-secondary); padding:24px;">No users found.</td></tr>';
        return;
    }

    tableBody.innerHTML = users.map(user => `
        <tr>
            <td>
                <div class="table-avatar">${user.username.charAt(0).toUpperCase()}</div>
            </td>
            <td>
                <span style="font-weight:500; color:var(--text-primary);">${user.username}</span>
            </td>
            <td>
                <span class="status-badge ${user.role === 'admin' ? 'status-downloading' : 'status-queued'}" style="text-transform:uppercase; font-size:10px;">
                    ${user.role}
                </span>
            </td>
            <td>
                <span class="status-badge ${user.is_active ? 'status-completed' : 'status-error'}" style="font-size:10px;">
                    ${user.is_active ? 'Active' : 'Disabled'}
                </span>
            </td>
            <td style="text-align:right;">
                <button class="btn-icon-glass" onclick="openEditUser('${user.id}', '${user.username}', '${user.role}', ${user.is_active})" title="Edit User">
                    <span class="material-icons">edit</span>
                </button>
            </td>
        </tr>
     `).join('');
}

window.openEditUser = function (userId, username, role, isActive) {
    document.getElementById('editUserId').value = userId;
    document.getElementById('editRole').value = role;
    document.getElementById('editStatus').value = isActive ? "1" : "0";
    document.getElementById('resetPassword').value = '';

    const editModal = document.getElementById('editUserModal');
    if (editModal) {
        editModal.classList.remove('hidden');
    }
};

// Profile Logic
async function loadProfile() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const user = await res.json();

        document.getElementById('profileUsername').textContent = user.username;
        const avatar = document.getElementById('profileAvatar');
        if (avatar) avatar.textContent = user.username.charAt(0).toUpperCase();

        const userIdEl = document.getElementById('profileUserId');
        if (userIdEl) userIdEl.textContent = 'ID: ' + user.id;

        const roleEl = document.getElementById('profileRole');
        roleEl.textContent = user.role;

        if (user.role === 'admin') {
            roleEl.className = 'profile-role-badge status-downloading';
        } else {
            roleEl.className = 'profile-role-badge status-queued';
        }
    } catch (e) {
        console.error("Failed to load profile:", e);
    }
}

// Check User Role and adjust UI
async function checkUserRole() {
    try {
        const res = await fetch('/api/auth/me');
        if (!res.ok) return;
        const user = await res.json();

        // 1. Hide "Users" tab if not admin
        const usersTab = document.querySelector('.sys-tab[data-tab="users"]');
        if (usersTab && user.role !== 'admin') {
            usersTab.style.display = 'none';
        }

        // 2. Hide "Enable Self-Registration" setting if not admin
        const regSetting = document.getElementById('containerEnableRegistration');
        if (regSetting && user.role !== 'admin') {
            regSetting.style.display = 'none';
        }
    } catch (e) {
        console.error("Failed to check user role:", e);
    }
}

// Call on init
document.addEventListener('DOMContentLoaded', () => {
    checkUserRole();
    setupSystemTabs();
});

window.openEditUser = function (id, username, role, isActive) {
    document.getElementById('editUserId').value = id;
    document.getElementById('editRole').value = role;
    document.getElementById('editStatus').value = isActive;
    document.getElementById('resetPassword').value = '';

    // Update Modal Title if needed, or just show it
    document.getElementById('editUserModal').classList.remove('hidden');
};

async function loadLibrary() {
    try {
        const res = await fetch('/api/library');
        if (!res.ok) return;
        const libraryJobs = await res.json();
        renderLibraryGrid(libraryJobs); // Authoritative Refresh based on server data
    } catch (e) {
        console.error("Library sync failed", e);
        showToast("Failed to refresh library", "error");
    }
}

function renderLibraryGrid(jobs) {
    const grid = document.getElementById('libraryGrid');
    if (!grid) return;

    const filteredJobs = jobs.filter(job => !window.pendingRemovals.has(job.id));

    if (filteredJobs.length === 0) {
        grid.innerHTML = `
            <div class="empty-placeholder">
                <span class="material-icons large-icon">video_library</span>
                <p>Your library is empty.</p>
                <small>Manual curated videos will appear here.</small>
            </div>`;
        return;
    }

    grid.innerHTML = filteredJobs.map(job => {
        const filename = job.filename ? job.filename.split(/[/\\]/).pop() : '';

        return `
            <div class="video-card video-card-completed compact-card entrance-anim" data-id="${job.id}" data-status="${job.status}" data-filename="${filename}">
                <div class="card-thumb-container" onclick="openPlayer(this.closest('.video-card')); event.stopPropagation();">
                    <img src="${job.thumbnail || ''}" class="card-thumb" style="opacity:0.9;">
                    <div class="video-preview-overlay" data-job-id="${job.id}"></div>
                    <div class="play-icon-hint"><span class="material-icons">play_circle</span></div>
                </div>
                <div class="card-body">
                    <h4 class="card-title">${job.title}</h4>
                    <div class="card-footer">
                        <div class="card-meta">
                            <!-- Metadata labels cleaned per user preference -->
                        </div>
                    </div>
                </div>
            </div>`;
    }).join('');

    attachVideoPreviewListeners();
}

// --- Selection & Bulk Logic ---
window.selectedJobs = [];

function toggleSelection(jobId, event) {
    if (currentPage === 'Library') return;

    if (event) {
        const target = event.target;
        const ignoreSelectors = '.card-body-actions, .card-actions, button, .btn-icon-glass';
        if (target.closest(ignoreSelectors)) return;

        // Prevent selection of items already in library if in Home view
        const card = target.closest('.video-card');
        if (card && card.classList.contains('in-library') && currentPage === 'Home') {
            return;
        }
    }

    const idx = window.selectedJobs.indexOf(jobId);
    if (idx > -1) {
        window.selectedJobs.splice(idx, 1);
    } else {
        window.selectedJobs.push(jobId);
    }

    const cards = document.querySelectorAll(`.video-card[data-id="${jobId}"]`);
    cards.forEach(card => card.classList.toggle('selected', window.selectedJobs.includes(jobId)));

    updateBulkBar();
}

function toggleSelectAll() {
    // Only select COMPLETED items in the active grid (Home/Downloads or Library)
    const activeGrid = (currentPage === 'Library') ? document.getElementById('libraryGrid') : document.getElementById('queueGrid');
    if (!activeGrid) return;

    const completedItems = Array.from(activeGrid.querySelectorAll('.video-card-completed'))
        .filter(card => !card.classList.contains('hidden'));

    const ids = completedItems.map(card => card.dataset.id);
    if (ids.length === 0) {
        showToast("No completed videos to select", "info");
        return;
    }

    // If all are already selected, deselect all. Otherwise select all.
    const allSelected = ids.every(id => window.selectedJobs.includes(id));

    if (allSelected) {
        window.selectedJobs = window.selectedJobs.filter(id => !ids.includes(id));
        document.getElementById('btnSelectAll').classList.remove('active');
    } else {
        ids.forEach(id => {
            if (!window.selectedJobs.includes(id)) window.selectedJobs.push(id);
        });
        document.getElementById('btnSelectAll').classList.add('active');
    }

    // Sync UI directly to avoid flicker
    ids.forEach(id => {
        // Toggle global selection state
        // (Logic already handled above: either added all or removed all)
    });

    // Update DOM classes directly without re-render
    if (activeGrid) {
        // We know exactly what we did: if allSelected (before click), we cleared. If not, we added all valid IDs.
        const shouldSelect = !allSelected;

        // Update all visible completed cards
        const cards = activeGrid.querySelectorAll('.video-card-completed');
        cards.forEach(card => {
            if (card.classList.contains('hidden')) return;
            // Only toggle if it's one of the target IDs (though querySelectorAll matches context)
            if (ids.includes(card.dataset.id)) {
                card.classList.toggle('selected', shouldSelect);
            }
        });
    }

    updateBulkBar();
}

function updateBulkBar() {
    const bar = document.getElementById('bulkActionBar');
    const countSpan = document.getElementById('selectionCount');
    if (!bar || !countSpan) return;

    const count = window.selectedJobs.length;
    countSpan.textContent = count;

    if (count > 0) {
        bar.classList.add('active');
        // Ensure buttons are visible
        const moveBtn = document.getElementById('btnBulkMove');
        if (moveBtn) {
            moveBtn.innerHTML = `<span class="material-icons">bookmark_add</span> Move ${count} to Library`;
            moveBtn.style.display = 'inline-flex';
        }
    } else {
        bar.classList.remove('active');
    }
}

// Wire Bulk Action Buttons
document.getElementById('btnBulkMove')?.addEventListener('click', () => {
    window.moveToLibrary(window.selectedJobs);
});

document.getElementById('btnBulkDelete')?.addEventListener('click', () => {
    window.bulkDeleteVideos(window.selectedJobs);
});

document.getElementById('btnBulkCancel')?.addEventListener('click', () => {
    window.selectedJobs = [];
    document.querySelectorAll('.video-card.selected').forEach(c => c.classList.remove('selected'));
    updateBulkBar();
});

// Store pending IDs for the modal
window.pendingMoveIds = [];

window.moveToLibrary = function (jobIds) {
    if (!jobIds || jobIds.length === 0) {
        showToast("No videos selected", "info");
        return;
    }

    window.pendingMoveIds = jobIds;
    const count = jobIds.length;

    // Update Modal Text
    const countSpan = document.getElementById('moveLibraryCount');
    if (countSpan) countSpan.textContent = `${count} item${count !== 1 ? 's' : ''}`;

    // Show Modal
    const modal = document.getElementById('moveLibraryModal');
    if (modal) modal.classList.remove('hidden');
};

// Modal Action Handlers
const confirmMoveBtn = document.getElementById('confirmMoveBtn');
const cancelMoveBtn = document.getElementById('cancelMoveBtn');
const moveModal = document.getElementById('moveLibraryModal');

if (confirmMoveBtn) {
    confirmMoveBtn.addEventListener('click', () => {
        if (moveModal) moveModal.classList.add('hidden');
        executeMoveToLibrary(window.pendingMoveIds);
    });
}

if (cancelMoveBtn) {
    cancelMoveBtn.addEventListener('click', () => {
        if (moveModal) moveModal.classList.add('hidden');
        window.pendingMoveIds = [];

        // Clear selection if it was a bulk action that was cancelled? 
        // Usually good UX to keep selection so user can try again or do something else.
        // But if it was a single action from card, there's no selection.
    });
}

async function executeMoveToLibrary(jobIds) {
    if (!jobIds || jobIds.length === 0) return;
    const count = jobIds.length;

    // --- [ OPTIMISTIC UI START ] ---
    // 1. Mark for removal (prevents re-render flicker)
    jobIds.forEach(id => window.pendingRemovals.add(id));

    // 2. Clear highlights and reset selection bar INSTANTLY
    const cards = document.querySelectorAll(jobIds.map(id => `.video-card[data-id="${id}"]`).join(','));
    cards.forEach(card => {
        card.classList.remove('selected');
        card.classList.add('removing');
    });

    window.selectedJobs = [];
    updateBulkBar();

    showToast(`Moving ${count} item(s) to Library...`, "info");
    // --- [ OPTIMISTIC UI END ] ---

    try {
        const response = await fetch('/api/library/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                job_ids: jobIds,
                in_library: true,
                in_downloads: false
            })
        });

        if (response.ok) {
            showToast(`Success: ${count} item(s) moved`, "success");
            // Give animation time to finish before full grid refresh of both views
            setTimeout(() => {
                cards.forEach(card => card.remove());
                updateQueue();
                if (currentPage === 'Library') loadLibrary();
            }, 300);
        } else {
            // Revert on error
            jobIds.forEach(id => window.pendingRemovals.delete(id));
            cards.forEach(card => {
                // Restore only if still partially visible
                card.classList.remove('removing');
            });
            const errText = await response.text();
            showToast("Failed to move: " + errText, "error");
            updateQueue(); // Refresh to restore correct selection state
        }
    } catch (e) {
        jobIds.forEach(id => window.pendingRemovals.delete(id));
        cards.forEach(card => card.classList.remove('removing'));
        showToast("Network error", "error");
    }
};

// Kept for backward compatibility if needed, but deleteVideo is now preferred
window.removeFromLibrary = async function (jobId) {
    return window.deleteVideo(jobId, 'library');
};

window.bulkDeleteVideos = async function (ids) {
    if (!ids || ids.length === 0) return;
    // Confirm removed
    // if (!confirm(`Are you sure you want to delete ${ids.length} videos?`)) return;

    showToast(`Deleting ${ids.length} videos...`, "info");

    ids.forEach(id => {
        const cards = document.querySelectorAll(`.video-card[data-id="${id}"]`);
        cards.forEach(card => {
            card.classList.remove('selected');
            card.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            card.style.opacity = '0';
            card.style.transform = 'scale(0.9) translateY(10px)';
        });
    });

    window.selectedJobs = [];
    updateBulkBar();

    try {
        const promises = ids.map(id => fetch(`/api/delete/${id}`, { method: 'DELETE' }));
        await Promise.all(promises);

        if (currentPage === 'Library') {
            await loadLibrary();
        } else {
            await updateQueue();
        }
        showToast("Videos deleted successfully", "success");
    } catch (e) {
        console.error("Bulk Delete Error:", e);
        showToast("Error deleting some videos", "error");
        if (currentPage === 'Library') loadLibrary(); else updateQueue();
    }
};

// --- Context Menu Logic ---
const contextMenu = document.getElementById('contextMenu');
let ctxTargetId = null;

// Global listener for right-click
document.addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.video-card');
    if (!card) {
        // If clicking outside card, close menu if open
        closeContextMenu();
        return;
    }

    e.preventDefault();
    const jobId = card.dataset.id;
    ctxTargetId = jobId;

    // Selection Logic for Context Menu
    // If we right-click a card that IS selected, we keep selection (assuming bulk action).
    // If we right-click a card that is NOT selected, we deselect others and select this one (single action).
    const isSelected = window.selectedJobs.includes(jobId);

    if (!isSelected) {
        // Clear previous selection and select this one
        window.selectedJobs = [jobId];
        document.querySelectorAll('.video-card.selected').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        updateBulkBar();
    }
    // If it WAS selected, we respect the current multi-selection (window.selectedJobs covers it)

    showContextMenu(e.pageX, e.pageY);
});

// Close menu on click anywhere
document.addEventListener('click', (e) => {
    if (!e.target.closest('.context-menu')) {
        closeContextMenu();
    }
});

// Close menu on scroll (to prevent floating menu in weird spots)
window.addEventListener('scroll', closeContextMenu, true);

function showContextMenu(x, y) {
    if (!contextMenu) return;

    // Conditionally show/hide 'Move to Library' based on current view
    const ctxMoveBtn = document.getElementById('ctxMove');
    if (ctxMoveBtn) {
        if (currentPage === 'Library') {
            ctxMoveBtn.style.display = 'none';
        } else {
            ctxMoveBtn.style.display = 'flex';
        }
    }

    // Adjust position to prevent overflow
    // We need visibility to measure, so remove hidden first but keep opacity 0 via CSS class if needed, 
    // or just calc with generic dims. 
    contextMenu.classList.remove('hidden');
    // Force reflow/active for transition usually handled by 'active' class
    requestAnimationFrame(() => {
        contextMenu.classList.add('active');

        const rect = contextMenu.getBoundingClientRect();
        const winWidth = window.innerWidth;
        const winHeight = window.innerHeight;

        let posX = x;
        let posY = y;

        if (posX + rect.width > winWidth) posX = winWidth - rect.width - 10;
        if (posY + rect.height > winHeight) posY = winHeight - rect.height - 10;

        contextMenu.style.left = `${posX}px`;
        contextMenu.style.top = `${posY}px`;
    });
}

function closeContextMenu() {
    if (!contextMenu) return;
    contextMenu.classList.remove('active');
    setTimeout(() => {
        if (!contextMenu.classList.contains('active')) {
            contextMenu.classList.add('hidden');
        }
    }, 200); // Wait for transition
}

// Bind Context Menu Actions
document.getElementById('ctxDelete')?.addEventListener('click', () => {
    if (window.selectedJobs.length > 0) {
        window.bulkDeleteVideos(window.selectedJobs);
    } else if (ctxTargetId) {
        window.deleteVideo(ctxTargetId, currentPage.toLowerCase());
    }
    closeContextMenu();
});

document.getElementById('ctxMove')?.addEventListener('click', () => {
    if (window.selectedJobs.length > 0) {
        window.moveToLibrary(window.selectedJobs);
    } else if (ctxTargetId) {
        window.moveToLibrary([ctxTargetId]);
    }
    closeContextMenu();
});

document.getElementById('ctxDownload')?.addEventListener('click', () => {
    // Only makes sense for single item or naive loop
    if (ctxTargetId) {
        window.startDownload(ctxTargetId);
    }
    closeContextMenu();
});

document.getElementById('ctxOpen')?.addEventListener('click', () => {
    if (ctxTargetId) {
        window.openJobFolder(ctxTargetId);
    }
    closeContextMenu();
});

/**
 * Move items to library (Modal Version)
 * @param {Array<string>} jobIds
 */
window.moveToLibrary = function (jobIds) {
    if (!jobIds || jobIds.length === 0) return;

    // Show Modal
    const modal = document.getElementById('moveLibraryModal');
    const countSpan = document.getElementById('moveLibraryCount');
    const confirmBtn = document.getElementById('confirmMoveBtn');
    const cancelBtn = document.getElementById('cancelMoveBtn');

    if (!modal) {
        console.error("Move modal not found");
        return;
    }

    countSpan.textContent = `${jobIds.length} item${jobIds.length > 1 ? 's' : ''}`;
    modal.classList.remove('hidden');

    // Handle Confirm
    confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        confirmBtn.textContent = "Moving...";

        try {
            const response = await fetch('/api/library/move', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ job_ids: jobIds })
            });

            if (response.ok) {
                showToast(`Moved ${jobIds.length} items to library`, 'success');
                // Remove from current view if needed
                if (window.selectedJobs) window.selectedJobs = [];
                updateBulkBar();

                // Optimistically remove from grid
                jobIds.forEach(id => {
                    const card = document.querySelector(`.video-card[data-id="${id}"]`);
                    if (card) card.remove();
                });

                // Refresh Data
                setTimeout(updateQueue, 500);
            } else {
                showToast('Failed to move items', 'error');
            }
        } catch (e) {
            showToast('Error moving items', 'error');
        } finally {
            confirmBtn.disabled = false;
            confirmBtn.textContent = "Move Items";
            modal.classList.add('hidden');
        }
    };

    // Handle Cancel
    cancelBtn.onclick = () => {
        modal.classList.add('hidden');
    };
};

/**
 * Bulk Move Trigger
 */
const btnBulkMove = document.getElementById('btnBulkMove');
if (btnBulkMove) {
    btnBulkMove.addEventListener('click', () => {
        if (window.selectedJobs && window.selectedJobs.length > 0) {
            window.moveToLibrary(window.selectedJobs);
        }
    });
}

// ============================================
// SELECTION LOGIC
// ============================================

if (!window.selectedJobs) window.selectedJobs = [];

window.toggleSelection = function (jobId, event) {
    // Prevent if clicking links/buttons (just in case stopPropagation missed something)
    if (event && (event.target.closest('button') || event.target.closest('a') || event.target.closest('.card-actions'))) return;

    const card = document.querySelector(`.video-card[data-id="${jobId}"]`);
    if (!card) return;

    card.classList.toggle('selected');

    if (card.classList.contains('selected')) {
        if (!window.selectedJobs.includes(jobId)) {
            window.selectedJobs.push(jobId);
        }
    } else {
        window.selectedJobs = window.selectedJobs.filter(id => id !== jobId);
    }

    // console.log('Selection:', window.selectedJobs);
};



// =============================================================
//  USER MANAGEMENT MODULE
//  Handles: loading users, create/edit modals, delete user
// =============================================================

// ---- State ----
let currentEditUserId = null;

// ---- DOM refs ----
const sysUsersTab = document.querySelector('.sys-tab[data-tab="users"]');
const sysUsersView = document.getElementById('sysUsersView');
const usersTableBody = document.getElementById('usersTableBody');

// Create user modal
const createUserBtn = document.getElementById('createUserBtn');
const createUserModal = document.getElementById('createUserModal');
const closeCreateUserBtn = document.getElementById('closeCreateUserBtn');
const cancelCreateUserBtn = document.getElementById('cancelCreateUserBtn');
const confirmCreateUserBtn = document.getElementById('confirmCreateUserBtn');
const newUsernameInput = document.getElementById('newUsername');
const newPasswordInput = document.getElementById('newPassword');
const newRoleInput = document.getElementById('newRole');

// Edit user modal
const editUserModal = document.getElementById('editUserModal');
const closeEditUserBtn = document.getElementById('closeEditUserBtn');
const cancelEditUserBtn = document.getElementById('cancelEditUserBtn');
const confirmEditUserBtn = document.getElementById('confirmEditUserBtn');
const deleteUserBtn = document.getElementById('deleteUserBtn');
const editUserIdInput = document.getElementById('editUserId');
const editRoleInput = document.getElementById('editRole');
const editStatusInput = document.getElementById('editStatus');
const resetPasswordInput = document.getElementById('resetPassword');

// ---- Helpers ----
function openModal(modal) { if (modal) modal.classList.remove('hidden'); }
function closeModal(modal) { if (modal) modal.classList.add('hidden'); }

function getInitials(username) {
    return (username || '?').charAt(0).toUpperCase();
}

function roleBadge(role) {
    const color = role === 'admin' ? '#0061a7' : '#4b5563';
    return `<span style="
        display:inline-block;
        padding:2px 10px;
        border-radius:12px;
        font-size:0.75rem;
        font-weight:600;
        background:${color}22;
        color:${color};
        border:1px solid ${color}44;
        text-transform:uppercase;
        letter-spacing:0.05em;"
    >${role}</span>`;
}

function statusBadge(isActive) {
    const on = isActive === 1 || isActive === true;
    return on
        ? `<span style="display:inline-flex; align-items:center; gap:4px; font-size:0.8rem; color:#15803d;">
            <span style="width:6px;height:6px;border-radius:50%;background:#15803d;display:inline-block;"></span>Active
           </span>`
        : `<span style="display:inline-flex; align-items:center; gap:4px; font-size:0.8rem; color:#9ca3af;">
            <span style="width:6px;height:6px;border-radius:50%;background:#9ca3af;display:inline-block;"></span>Disabled
           </span>`;
}

// ---- Load & Render Users ----
async function loadUsers() {
    if (!usersTableBody) return;
    usersTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--text-tertiary);">
        <span class="material-icons spin">sync</span>
    </td></tr>`;

    try {
        const res = await fetch('/api/users');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const users = await res.json();
        renderUsersTable(users);
    } catch (e) {
        console.error('[Users] Failed to load:', e);
        usersTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:24px; color:var(--danger);">
            Failed to load users.
        </td></tr>`;
    }
}

function renderUsersTable(users) {
    if (!usersTableBody) return;

    if (!users || users.length === 0) {
        usersTableBody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:32px; color:var(--text-tertiary);">
            No users found.
        </td></tr>`;
        return;
    }

    usersTableBody.innerHTML = users.map(u => `
        <tr>
            <td>
                <div style="
                    width:36px; height:36px; border-radius:50%;
                    background: linear-gradient(135deg, var(--primary), var(--accent));
                    display:flex; align-items:center; justify-content:center;
                    font-weight:700; font-size:0.9rem; color:#fff;">
                    ${getInitials(u.username)}
                </div>
            </td>
            <td style="font-weight:500;">${u.username || '—'}</td>
            <td>${roleBadge(u.role || 'user')}</td>
            <td>${statusBadge(u.is_active)}</td>
            <td style="text-align:right;">
                <button
                    class="btn-icon-glass"
                    style="width:32px; height:32px;"
                    title="Edit user"
                    onclick='openEditUserModal(${JSON.stringify(u).replace(/'/g, "\\'")})'>
                    <span class="material-icons" style="font-size:16px;">edit</span>
                </button>
            </td>
        </tr>
    `).join('');
}

// ---- Open Edit Modal ----
window.openEditUserModal = function (user) {
    if (!editUserModal) return;
    currentEditUserId = user.id;
    document.getElementById('editUserId').value = user.id;
    editRoleInput.value = user.role || 'user';
    editStatusInput.value = String(user.is_active ?? 1);
    if (resetPasswordInput) resetPasswordInput.value = '';

    // Protect admins from deletion in UI
    const deleteBtn = document.getElementById('deleteUserBtn');
    if (deleteBtn) {
        if (user.role === 'admin') {
            deleteBtn.style.display = 'none';
        } else {
            deleteBtn.style.display = 'block';
        }
    }

    openModal(editUserModal);
};

// ---- Save Edit ----
if (confirmEditUserBtn) {
    confirmEditUserBtn.addEventListener('click', async () => {
        const userId = document.getElementById('editUserId')?.value;
        const role = editRoleInput?.value;
        const isActive = parseInt(editStatusInput?.value ?? '1');
        const newPw = resetPasswordInput?.value?.trim();

        if (!userId) return;

        try {
            // Update role + status
            const res = await fetch(`/api/users/${userId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role, is_active: isActive })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showToast(err.detail || 'Failed to update user', 'error');
                return;
            }

            // Optional password reset
            if (newPw) {
                const pwRes = await fetch(`/api/users/${userId}/reset-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: newPw })
                });
                if (!pwRes.ok) {
                    showToast('User updated but password reset failed', 'warning');
                    closeModal(editUserModal);
                    loadUsers();
                    return;
                }
            }

            showToast('User updated successfully', 'success');
            closeModal(editUserModal);
            loadUsers();

        } catch (e) {
            console.error('[Users] Save edit error:', e);
            showToast('Network error updating user', 'error');
        }
    });
}

// ---- DELETE USER ----
window.handleDeleteUser = async function () {
    const userId = document.getElementById('editUserId')?.value;
    if (!userId) return;

    // Confirmation prompt
    const confirmed = confirm(
        'Are you sure you want to permanently delete this user?\nThis action cannot be undone.'
    );
    if (!confirmed) return;

    try {
        const res = await fetch(`/api/users/${userId}`, { method: 'DELETE' });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            showToast(err.detail || 'Failed to delete user', 'error');
            return;
        }

        showToast('User deleted', 'success');
        closeModal(editUserModal);
        loadUsers();

    } catch (e) {
        console.error('[Users] Delete error:', e);
        showToast('Network error deleting user', 'error');
    }
};

// ---- Close Edit Modal ----
[closeEditUserBtn, cancelEditUserBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => closeModal(editUserModal));
});

// ---- Create User Modal ----
if (createUserBtn) {
    createUserBtn.addEventListener('click', () => {
        if (newUsernameInput) newUsernameInput.value = '';
        if (newPasswordInput) newPasswordInput.value = '';
        if (newRoleInput) newRoleInput.value = 'user';
        openModal(createUserModal);
    });
}

[closeCreateUserBtn, cancelCreateUserBtn].forEach(btn => {
    if (btn) btn.addEventListener('click', () => closeModal(createUserModal));
});

if (confirmCreateUserBtn) {
    confirmCreateUserBtn.addEventListener('click', async () => {
        const username = newUsernameInput?.value?.trim();
        const password = newPasswordInput?.value?.trim();
        const role = newRoleInput?.value || 'user';

        if (!username || !password) {
            showToast('Username and password are required', 'error');
            return;
        }

        try {
            const res = await fetch('/api/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, role })
            });

            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                showToast(err.detail || 'Failed to create user', 'error');
                return;
            }

            showToast(`User "${username}" created`, 'success');
            closeModal(createUserModal);
            loadUsers();

        } catch (e) {
            console.error('[Users] Create error:', e);
            showToast('Network error creating user', 'error');
        }
    });
}

// ---- Load users whenever the Users tab is activated ----
// The sys-tab click is handled elsewhere (or inline below).
// We hook into the system tabs toggle logic:
document.querySelectorAll('.sys-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        if (tab.dataset.tab === 'users') {
            loadUsers();
        }
    });
});

// Close modals when clicking outside their content box
[createUserModal, editUserModal].forEach(modal => {
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal);
    });
});
