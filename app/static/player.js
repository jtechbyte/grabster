document.addEventListener('DOMContentLoaded', () => {
    // Custom: Volume Persistence Logic
    const savedVolume = localStorage.getItem('player_volume');
    const initialVolume = savedVolume ? parseFloat(savedVolume) : 1;

    // Custom: Theme Persistence
    if (localStorage.getItem('theme') === 'light') {
        document.body.classList.add('light-theme');
    }

    // Custom: Settings Persistence
    const savedAutoplay = localStorage.getItem('player_autoplay') === 'true';
    const savedLoop = localStorage.getItem('player_loop') === 'true';

    // Update UI initial state
    updateToggleUI('autoplayBtn', savedAutoplay, 'play_circle_filled', 'play_circle_outline');
    updateToggleUI('loopBtn', savedLoop, 'repeat_on', 'repeat');

    // Custom: Resume Playback Logic
    // Use global config injected from HTML
    const jobId = window.VIDEO_CONFIG.jobId;

    // Fetch Local View Count on page load
    fetch(`/api/video/${jobId}/views`)
        .then(r => r.json())
        .then(data => {
            if (data.views !== undefined) {
                const viewsSpan = document.getElementById('viewCount');
                if (viewsSpan) {
                    const formatted = new Intl.NumberFormat().format(data.views);
                    viewsSpan.textContent = `${formatted} views`;
                    console.log('[PLAYER] Initial view count loaded:', data.views);
                }
            }
        })
        .catch(err => console.warn('[PLAYER] Failed to fetch view count:', err));

    const resumeKey = `resume_${jobId}`;
    const savedTime = localStorage.getItem(resumeKey);

    // Initialize Plyr with speed controls and Pip
    const player = new Plyr('#player', {
        controls: ['play-large', 'play', 'progress', 'current-time', 'mute', 'volume', 'captions',
            'settings', 'pip', 'airplay', 'fullscreen'
        ],
        settings: ['speed'],
        speed: {
            selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2]
        },
        keyboard: {
            focused: true, global: true
        },
        tooltips: {
            controls: true, seek: true
        },
        autoplay: savedAutoplay,
        volume: initialVolume,
        loop: { active: savedLoop }
    });

    // === Live Stream Extraction Logic ===
    const isLocal = window.VIDEO_CONFIG.filename !== "";
    const directUrl = window.VIDEO_CONFIG.url;

    if (!isLocal && directUrl) {
        console.log("[PLAYER] Detected mode: extracting stream...", directUrl);

        fetch(`/api/stream/live?url=${encodeURIComponent(directUrl)}`)
            .then(r => {
                if (!r.ok) throw new Error("Failed to extract stream");
                return r.json();
            })
            .then(data => {
                console.log("[PLAYER] Stream extracted:", data.url);
                const streamUrl = data.url;

                // Determine if HLS
                const isHLS = streamUrl.includes('.m3u8') || streamUrl.includes('manifest');

                if (isHLS && Hls.isSupported()) {
                    console.log("[PLAYER] Initializing HLS.js for live stream");
                    const hls = new Hls({
                        enableWorker: true,
                        lowLatencyMode: true,
                        backBufferLength: 90
                    });

                    const videoElement = document.getElementById('player');
                    hls.loadSource(streamUrl);
                    hls.attachMedia(videoElement);
                    window.hls = hls; // Store globally for cleanup if needed

                    hls.on(Hls.Events.MANIFEST_PARSED, function () {
                        console.log("[PLAYER] HLS Manifest parsed, starting playback");
                        if (savedAutoplay) player.play();
                    });
                } else {
                    console.log("[PLAYER] Using standard video source (Direct/MP4)");
                    player.source = {
                        type: 'video',
                        sources: [
                            {
                                src: streamUrl,
                                type: 'video/mp4',
                            }
                        ]
                    };
                    if (savedAutoplay) player.play();
                }

                // Hide loader
                const loader = document.getElementById('streamLoading');
                if (loader) loader.style.display = 'none';
            })
            .catch(err => {
                console.error("[PLAYER] Stream error:", err);
                const loader = document.getElementById('streamLoading');
                if (loader) {
                    loader.innerHTML = `
                        <span class="material-icons" style="font-size:48px; color:var(--error); margin-bottom:16px;">error_outline</span>
                        <span style="color:white; font-weight:500;">Stream Unavailable</span>
                        <small style="color:#aaa; margin-top:8px;">${err.message}</small>
                     `;
                }
            });
    }

    // Restore Volume & Time on Ready/LoadedMetadata
    // We listen to both because sometimes metadata loads before ready or vice versa
    let resumed = false;

    function attemptResume() {
        // Apply Autoplay if configured (and not yet resumed/played)
        const urlParams = new URLSearchParams(window.location.search);
        const forceAutoplay = urlParams.get('autoplay') === '1';

        if (!resumed && (savedAutoplay || forceAutoplay) && player.paused) {
            player.play().catch(() => console.log('Autoplay blocked by browser'));
        }

        if (resumed || !savedTime) return;

        const time = parseFloat(savedTime);
        const duration = player.duration;

        if (duration > 0) {
            // Only resume if > 5s and < 95% to avoid loops
            if (time > 5 && time < (duration * 0.95)) {
                player.currentTime = time;
                resumed = true;
            } else {
                resumed = true;
            }
        }
    }

    player.on('ready', attemptResume);
    player.on('loadedmetadata', attemptResume);

    // === View Tracking Logic (User Provided) ===
    let viewCounted = false;
    let activeInterval = null;

    player.on('playing', () => {
        if (viewCounted) return;

        // Clear any existing interval to prevent duplicates (debounce)
        if (activeInterval) clearInterval(activeInterval);

        let playedSeconds = 0;
        activeInterval = setInterval(() => {
            if (viewCounted) {
                clearInterval(activeInterval);
                return;
            }

            if (!player.paused && !player.ended) {
                playedSeconds++;
                // console.log('[VIEW TRACKING] Watched:', playedSeconds);
                if (playedSeconds >= 5) {
                    clearInterval(activeInterval);
                    if (viewCounted) return; // Double check

                    const videoId = window.VIDEO_CONFIG.jobId;
                    console.log('[VIEW TRACKING] 5s threshold reached for:', videoId);

                    // Increment view on backend
                    fetch(`/api/video/${videoId}/view`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' }
                    })
                        .then(res => res.json())
                        .then(data => {
                            const viewCountEl = document.getElementById('viewCount');
                            if (viewCountEl && data.views !== undefined) {
                                viewCountEl.textContent = new Intl.NumberFormat().format(data.views) + " views";
                            } else {
                                console.warn('[VIEW TRACKING] Missing data.views in response or element unavailable');
                            }
                        })
                        .catch(err => {
                            console.error('[VIEW TRACKING] Fetch error:', err);
                        });

                    viewCounted = true;
                }
            }
        }, 1000);
    });

    // Clear interval on pause to be safe
    player.on('pause', () => {
        if (activeInterval) clearInterval(activeInterval);
    });


    // Save volume on change
    player.on('volumechange', (event) => {
        const vol = player.volume;
        localStorage.setItem('player_volume', vol);
    });

    // Save progress periodically (on timeupdate is too frequent, so we check every 2s or use throttle)
    // Simpler: Just save on timeupdate but maybe check diff? 
    // Plyr timeupdate fires frequently. LocalStorage is sync. 
    // Better to use a small interval or throttle.
    let lastSave = 0;

    player.on('timeupdate', (event) => {
        const now = Date.now();

        if (now - lastSave > 2000) {
            // Save every 2s
            localStorage.setItem(resumeKey, player.currentTime);
            lastSave = now;
        }
    });

    // Expose to window for debugging and UI handlers
    window.player = player;
});

// UI Helpers
function updateToggleUI(id, isActive, iconOn, iconOff) {
    const btn = document.getElementById(id);
    if (!btn) return;
    const icon = btn.querySelector('.material-icons');

    if (isActive) {
        btn.style.color = 'var(--primary)';
        btn.style.background = 'rgba(var(--primary-rgb, 100, 100, 255), 0.1)';
        icon.textContent = iconOn;
    }

    else {
        btn.style.color = '';
        btn.style.background = '';
        icon.textContent = iconOff;
    }
}

function toggleAutoplay() {
    const current = localStorage.getItem('player_autoplay') === 'true';
    const newState = !current;
    localStorage.setItem('player_autoplay', newState);
    updateToggleUI('autoplayBtn', newState, 'play_circle_filled', 'play_circle_outline');

    // Note: Autoplay effect happens on next load
    if (newState && window.player && window.player.paused) {
        window.player.play();
    }
}

function toggleLoop() {
    const current = localStorage.getItem('player_loop') === 'true';
    const newState = !current;
    localStorage.setItem('player_loop', newState);
    updateToggleUI('loopBtn', newState, 'repeat_on', 'repeat');

    if (window.player) {
        window.player.loop = newState;
    }
}

const dialog = document.getElementById('infoDialog');

function openInfoDialog() {
    if (dialog) dialog.classList.remove('hidden');
}

function closeInfoDialog() {
    if (dialog) dialog.classList.add('hidden');
}

function downloadVideo() {
    // Direct download link
    // We'll create a temporary link to force download
    // Using global config
    const link = document.createElement('a');
    link.href = `/api/stream/${window.VIDEO_CONFIG.jobId}`;
    // Attempt to extract filename or default
    const filename = window.VIDEO_CONFIG.filename;
    link.download = filename ? filename.split(/[\/\\]/).pop() : "video.mp4";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function copyShareLink() {
    const url = window.location.href;

    navigator.clipboard.writeText(url).then(() => {
        alert('Link copied to clipboard!');
    });
}

// Close dialog on click outside
if (dialog) {
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) closeInfoDialog();
    });
}
