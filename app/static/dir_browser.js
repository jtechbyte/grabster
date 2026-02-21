// Directory Browser Logic
const dirBrowserModal = document.getElementById('dirBrowserModal');
const browseDirBtn = document.getElementById('browseDirBtn');
const closeDirBrowserBtn = document.getElementById('closeDirBrowserBtn');
const selectDirBtn = document.getElementById('selectDirBtn');
const cancelDirBtn = document.getElementById('cancelDirBtn');
const dirBreadcrumb = document.getElementById('dirBreadcrumb');
const dirList = document.getElementById('dirList');
const dirDrives = document.getElementById('dirDrives');
const settingDownloadDir = document.getElementById('settingDownloadDir');

let currentPath = '';

async function loadDirectory(path = null) {
    try {
        const url = path ? `/api/browse-directory?path=${encodeURIComponent(path)}` : '/api/browse-directory';
        const res = await fetch(url);
        const data = await res.json();

        if (data.error) {
            showToast(data.error, 'error');
            return;
        }

        currentPath = data.current_path;

        // Update breadcrumb
        dirBreadcrumb.textContent = currentPath;

        // Show drives (Windows)
        if (data.drives && data.drives.length > 0) {
            dirDrives.innerHTML = `
                <div class="drives-container">
                    ${data.drives.map(drive => `
                        <button class="btn-drive" data-path="${drive.path}">
                            <span class="material-icons">storage</span> ${drive.name}
                        </button>
                    `).join('')}
                </div>
            `;
        } else {
            dirDrives.innerHTML = '';
        }

        // Render directory list
        let html = '';

        // Parent directory button
        if (data.parent_path) {
            html += `
                <div class="dir-item parent-dir" data-path="${data.parent_path}">
                    <span class="material-icons">arrow_upward</span>
                    <span>..</span>
                </div>
            `;
        }

        // Directories
        data.directories.forEach(dir => {
            html += `
                <div class="dir-item" data-path="${dir.path}">
                    <span class="material-icons">folder</span>
                    <span>${dir.name}</span>
                </div>
            `;
        });

        if (!html) {
            html = '<div style="padding: 16px; text-align: center; color: rgba(255,255,255,0.5);">No subdirectories</div>';
        }

        dirList.innerHTML = html;

        // Remove manual hover handlers (handled by CSS)
        dirList.querySelectorAll('.dir-item').forEach(item => {
            item.addEventListener('click', () => {
                loadDirectory(item.dataset.path);
            });
        });

        // Drive buttons
        dirDrives.querySelectorAll('button').forEach(btn => {
            btn.addEventListener('click', () => {
                loadDirectory(btn.dataset.path);
            });
        });

    } catch (error) {
        showToast('Error loading directory', 'error');
        console.error(error);
    }
}

// Browse button click
if (browseDirBtn) {
    browseDirBtn.addEventListener('click', () => {
        dirBrowserModal.classList.remove('hidden');
        loadDirectory(settingDownloadDir.value || null);
    });
}

// Close modal
[closeDirBrowserBtn, cancelDirBtn].forEach(btn => {
    if (btn) {
        btn.addEventListener('click', () => {
            dirBrowserModal.classList.add('hidden');
        });
    }
});

// Select directory
if (selectDirBtn) {
    selectDirBtn.addEventListener('click', () => {
        settingDownloadDir.value = currentPath;
        dirBrowserModal.classList.add('hidden');
        showToast('Directory selected', 'success');
    });
}

// Close modal on outside click
window.addEventListener('click', (e) => {
    if (e.target === dirBrowserModal) {
        dirBrowserModal.classList.add('hidden');
    }
});
