/* ========================================
   SOPGen — Frontend Application
   ======================================== */

// ---- API Client ----
const api = {
  async get(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async post(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
  async upload(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', url);
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
        };
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(JSON.parse(xhr.responseText));
        } else {
          try { reject(new Error(JSON.parse(xhr.responseText).error)); }
          catch { reject(new Error(xhr.statusText)); }
        }
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(formData);
    });
  },
  async del(url) {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    return res.json();
  },
};

// ---- Utils ----
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function statusLabel(status) {
  const labels = {
    uploaded: 'Ready',
    processing: 'Processing',
    transcribing: 'Transcribing',
    segmenting: 'Segmenting',
    generating_clips: 'Generating Clips',
    generating_sops: 'Generating SOPs',
    complete: 'Complete',
    error: 'Error',
  };
  return labels[status] || status;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ---- Router ----
const router = {
  routes: {},
  register(path, handler) { this.routes[path] = handler; },
  navigate(path) { window.location.hash = path; },
  init() {
    window.addEventListener('hashchange', () => this.resolve());
    this.resolve();
  },
  resolve() {
    const hash = window.location.hash.slice(1) || '/';
    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
      link.classList.toggle('active', link.dataset.route === hash || (hash.startsWith('/video/') && link.dataset.route === '/'));
    });

    // Match route
    for (const [pattern, handler] of Object.entries(this.routes)) {
      const regex = new RegExp('^' + pattern.replace(/:\w+/g, '([^/]+)') + '$');
      const match = hash.match(regex);
      if (match) {
        handler(...match.slice(1));
        return;
      }
    }
    // Fallback
    this.routes['/']?.();
  },
};

// ---- Polling Manager ----
let pollIntervals = {};
function startPolling(videoId, callback, interval = 3000) {
  stopPolling(videoId);
  pollIntervals[videoId] = setInterval(callback, interval);
}
function stopPolling(videoId) {
  if (pollIntervals[videoId]) {
    clearInterval(pollIntervals[videoId]);
    delete pollIntervals[videoId];
  }
}
function stopAllPolling() {
  Object.keys(pollIntervals).forEach(stopPolling);
}

// ---- Views ----

// Dashboard
async function renderDashboard() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="page-header">
      <h1>Your Videos</h1>
      <p>Upload a video or paste a YouTube link to generate SOPs</p>
    </div>
    
    <div class="dashboard-upload-section">
      <div class="upload-container">
        <div class="card-glass upload-dropzone" id="dropzone">
          <div class="upload-icon">📁</div>
          <h3>Quick Upload</h3>
          <p>Drop a video or click to browse</p>
          <input type="file" id="file-input" accept="video/*">
        </div>
        <div id="upload-progress" style="display:none" class="upload-progress">
          <div class="upload-progress-label">
            <span id="upload-file-name"></span>
            <span id="upload-percent">0%</span>
          </div>
          <div class="progress-bar"><div class="progress-bar-fill" id="upload-bar" style="width:0%"></div></div>
        </div>
        <div class="divider">or</div>
        <div class="youtube-input-group">
          <input type="text" id="youtube-url-dash" placeholder="Paste a YouTube URL..." />
          <button class="btn btn-primary" id="youtube-btn-dash">Download</button>
        </div>
      </div>
    </div>

    <div id="video-list" style="margin-top: 3rem;">
      <div class="empty-state">
        <div class="spinner" style="width:32px;height:32px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem;"></div>
        <p>Loading your videos...</p>
      </div>
    </div>
  `;

  // Initialize Upload/YouTube Listeners
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');
  const ytInput = document.getElementById('youtube-url-dash');
  const ytBtn = document.getElementById('youtube-btn-dash');

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFileUpload(e.target.files[0]);
  });
  ytBtn.addEventListener('click', () => {
    const url = ytInput.value.trim();
    if (!url) { showToast('Please enter a YouTube URL', 'error'); return; }

    ytBtn.disabled = true;
    ytBtn.textContent = 'Downloading...';

    api.post('/api/videos/youtube', { url })
      .then(result => {
        showToast('YouTube download started!', 'success');
        router.navigate(`/video/${result.id}`);
      })
      .catch(err => {
        showToast('Download failed: ' + err.message, 'error');
        ytBtn.disabled = false;
        ytBtn.textContent = 'Download';
      });
  });

  try {
    const videos = await api.get('/api/videos');
    const container = document.getElementById('video-list');

    if (videos.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🎬</div>
          <h3>No videos yet</h3>
          <p>The list is empty. Start by uploading above!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = `<div class="video-grid">${videos.map(v => videoCard(v)).join('')}</div>`;

    // Start polling for processing videos
    videos.filter(v => !['uploaded', 'complete', 'error'].includes(v.status)).forEach(v => {
      startPolling(v.id, async () => {
        try {
          const updated = await api.get(`/api/videos/${v.id}`);
          const card = document.querySelector(`[data-video-id="${v.id}"]`);
          if (card) {
            card.outerHTML = videoCard(updated);
          }
          if (['complete', 'error'].includes(updated.status)) {
            stopPolling(v.id);
          }
        } catch (e) { /* ignore */ }
      });
    });
  } catch (err) {
    document.getElementById('video-list').innerHTML = `<div class="empty-state"><p style="color:var(--error)">Failed to load videos: ${escapeHtml(err.message)}</p></div>`;
  }
}

function videoCard(v) {
  const thumb = v.thumbnail_path
    ? `<img src="/data/${v.thumbnail_path}" alt="${escapeHtml(v.title)}">`
    : `<div class="video-thumb-placeholder">🎥</div>`;

  return `
    <div class="card video-card" data-video-id="${v.id}" onclick="router.navigate('/video/${v.id}')">
      <div class="video-thumb">
        ${thumb}
        ${v.duration_seconds ? `<span class="video-duration">${formatDuration(v.duration_seconds)}</span>` : ''}
      </div>
      <h3>${escapeHtml(v.title)}</h3>
      <div class="video-card-meta">
        <span class="badge badge-${v.status}">${statusLabel(v.status)}</span>
        <span>${formatDate(v.created_at)}</span>
      </div>
    </div>
  `;
}

// Upload
function renderUpload() {
  stopAllPolling();
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="page-header">
      <h1>Upload Video</h1>
      <p>Upload a video file or paste a YouTube URL to begin processing</p>
    </div>
    <div class="upload-container">
      <div class="card-glass upload-dropzone" id="dropzone">
        <div class="upload-icon">📁</div>
        <h3>Drop your video here</h3>
        <p>or click to browse — MP4, MOV, AVI, MKV, WebM (max 2GB)</p>
        <input type="file" id="file-input" accept="video/*">
      </div>
      <div id="upload-progress" style="display:none" class="upload-progress">
        <div class="upload-progress-label">
          <span id="upload-file-name"></span>
          <span id="upload-percent">0%</span>
        </div>
        <div class="progress-bar"><div class="progress-bar-fill" id="upload-bar" style="width:0%"></div></div>
      </div>
      <div class="divider">or</div>
      <div class="youtube-input-group">
        <input type="text" id="youtube-url" placeholder="Paste a YouTube URL..." />
        <button class="btn btn-primary" id="youtube-btn" onclick="handleYoutube()">Download</button>
      </div>
    </div>
  `;

  // Drag & drop
  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('file-input');

  dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag-over'); });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag-over');
    if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) handleFileUpload(e.target.files[0]);
  });
}

async function handleFileUpload(file) {
  const progressDiv = document.getElementById('upload-progress');
  const fileNameEl = document.getElementById('upload-file-name');
  const percentEl = document.getElementById('upload-percent');
  const barEl = document.getElementById('upload-bar');

  progressDiv.style.display = 'block';
  fileNameEl.textContent = file.name;

  const formData = new FormData();
  formData.append('video', file);
  formData.append('title', file.name.replace(/\.[^/.]+$/, ''));

  try {
    const result = await api.upload('/api/videos/upload', formData, (pct) => {
      percentEl.textContent = pct + '%';
      barEl.style.width = pct + '%';
    });
    showToast('Video uploaded successfully!', 'success');
    router.navigate(`/video/${result.id}`);
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
    progressDiv.style.display = 'none';
  }
}

async function handleYoutube() {
  const urlInput = document.getElementById('youtube-url');
  const btn = document.getElementById('youtube-btn');
  const url = urlInput.value.trim();

  if (!url) { showToast('Please enter a YouTube URL', 'error'); return; }

  btn.disabled = true;
  btn.textContent = 'Downloading...';

  try {
    const result = await api.post('/api/videos/youtube', { url });
    showToast('YouTube download started!', 'success');
    router.navigate(`/video/${result.id}`);
  } catch (err) {
    showToast('Download failed: ' + err.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Download';
  }
}

// Video Detail
async function renderVideoDetail(videoId) {
  stopAllPolling();
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty-state"><div class="spinner" style="width:32px;height:32px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem;"></div><p>Loading video...</p></div>`;

  try {
    const video = await api.get(`/api/videos/${videoId}`);
    renderVideoDetailContent(video);

    // Poll if processing
    if (!['uploaded', 'complete', 'error'].includes(video.status)) {
      startPolling(videoId, async () => {
        if (isConfirming) return; // Skip polling while user is interacting with a dialog
        try {
          const updated = await api.get(`/api/videos/${videoId}`);
          if (isConfirming) return; // Re-check after async op
          renderVideoDetailContent(updated);
          if (['uploaded', 'complete', 'error'].includes(updated.status)) {
            stopPolling(videoId);
            if (updated.status === 'complete') showToast('Processing complete! 🎉', 'success');
          }
        } catch (e) { /* ignore */ }
      });
    }
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><p style="color:var(--error)">Failed to load video: ${escapeHtml(err.message)}</p><br><a href="#/" class="btn btn-secondary">← Back</a></div>`;
  }
}

function renderVideoDetailContent(video) {
  const app = document.getElementById('app');
  const isProcessing = !['uploaded', 'complete', 'error'].includes(video.status);
  const clips = video.clips || [];

  let clipsHtml = '';
  if (isProcessing) {
    const statusMessages = {
      processing: 'Preparing video...',
      transcribing: 'Transcribing audio with AI...',
      segmenting: 'Identifying topics and segments...',
      generating_clips: 'Generating video clips...',
      generating_sops: 'Creating SOP documents...',
    };

    // Split logs and show last 10
    const logs = (video.pipeline_logs || '').split('\n').filter(Boolean);
    const recentLogs = logs.slice(-10).reverse();

    // Look for download progress in logs
    let progressHtml = '';
    const lastLogWithDownload = [...logs].reverse().find(l => l.includes('Downloading:'));
    if (lastLogWithDownload) {
      const pctMatch = lastLogWithDownload.match(/Downloading:\s+(\d+\.\d+)%/);
      if (pctMatch) {
        const pct = pctMatch[1];
        progressHtml = `
          <div class="download-progress-status" style="margin-bottom: 2rem;">
            <div style="display:flex; justify-content:space-between; font-size:0.9rem; margin-bottom:0.5rem; color:var(--text-secondary);">
              <span>Downloading from YouTube...</span>
              <span>${pct}%</span>
            </div>
            <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
          </div>
        `;
      }
    }

    // Estimate remaining time
    let estimateHtml = '';
    if (video.estimated_finish_at) {
      const finishTs = new Date(video.estimated_finish_at).getTime();
      const now = Date.now();
      const diffMin = Math.ceil((finishTs - now) / 60000);

      if (diffMin > 0) {
        estimateHtml = `
          <div class="estimate-badge" style="display:inline-flex; align-items:center; gap:0.5rem; background:rgba(255,255,255,0.05); padding:0.4rem 0.8rem; border-radius:20px; font-size:0.85rem; color:var(--text-secondary); margin-bottom:1rem;">
            <span style="display:block; width:8px; height:8px; background:var(--accent); border-radius:50%; animation: pulse 2s infinite;"></span>
            Roughly ${diffMin} ${diffMin === 1 ? 'minute' : 'minutes'} remaining
          </div>
        `;
      }
    }

    clipsHtml = `
      <div class="card processing-status">
        <div class="spinner"></div>
        <h3>${statusMessages[video.status] || 'Processing...'}</h3>
        <p>Processing continues in the background. You can leave this page.</p>
        
        ${estimateHtml}
        ${progressHtml}

        <div class="pipeline-logs-container">
          <h4>Recent Activity</h4>
          <div class="pipeline-logs">
            ${recentLogs.length > 0 ? recentLogs.map(log => `
              <div class="log-entry">${escapeHtml(log)}</div>
            `).join('') : '<div class="log-entry-muted">Waiting for updates...</div>'}
          </div>
        </div>
      </div>
    `;
  } else if (video.status === 'error') {
    clipsHtml = `
      <div class="card" style="border-color: rgba(239,68,68,0.3);">
        <h3 style="color:var(--error);">⚠ Processing Error</h3>
        <p style="color:var(--text-secondary); margin-top:0.5rem;">${escapeHtml(video.error_message)}</p>
        <div class="pipeline-logs-container" style="margin-top:1rem;">
          <h4>Error Details</h4>
          <div class="pipeline-logs">
            ${(video.pipeline_logs || '').split('\n').slice(-5).reverse().map(l => `<div class="log-entry">${escapeHtml(l)}</div>`).join('')}
          </div>
        </div>
      </div>
    `;
  } else if (video.status === 'complete' && clips.length > 0) {
    clipsHtml = `
      <div class="clips-section">
        <h2>Generated Clips & SOPs (${clips.length})</h2>
        <div class="clip-list">
          ${clips.map(clip => `
            <div class="card clip-item" onclick="router.navigate('/sop/${clip.id}')">
              <div class="clip-number">${clip.clip_index}</div>
              <div class="clip-info">
                <h3>${escapeHtml(clip.title)}</h3>
                <p>${escapeHtml(clip.description || '')}</p>
                <span class="clip-time">${formatDuration(clip.start_time)} → ${formatDuration(clip.end_time)} (${formatDuration(clip.end_time - clip.start_time)})</span>
              </div>
              <span class="badge badge-${clip.status}">${clip.sopSteps?.length || 0} steps</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  } else if (video.status === 'complete') {
    clipsHtml = `<div class="empty-state"><p>Processing complete but no clips were generated. The video may be too short or unclear.</p></div>`;
  }

  app.innerHTML = `
    <div class="breadcrumb">
      <a href="#/">Dashboard</a> <span>›</span> <span>${escapeHtml(video.title)}</span>
    </div>
    <div class="detail-header">
      <h1>${escapeHtml(video.title)}</h1>
      <div class="detail-meta">
        <span class="badge badge-${video.status}">${statusLabel(video.status)}</span>
        ${video.duration_seconds ? `<span>⏱ ${formatDuration(video.duration_seconds)}</span>` : ''}
        ${video.video_size_mb ? `<span>📦 ${Math.round(video.video_size_mb)} MB</span>` : ''}
        <span>${formatDate(video.created_at)}</span>
        ${video.source_url ? `<span>🔗 YouTube</span>` : '<span>📁 Uploaded</span>'}
      </div>
      <div class="detail-actions" style="display:flex; align-items:center; gap:0.5rem;">
        ${video.status === 'uploaded' ? `<button class="btn btn-primary" onclick="processVideo('${video.id}')">🚀 Start Processing</button>` : ''}
        ${video.status === 'error' && video.error_message === 'Processing stopped by user' ? `<button class="btn btn-primary" onclick="processVideo('${video.id}')">🔄 Resume Processing</button>` : ''}
        ${video.status === 'error' && video.error_message !== 'Processing stopped by user' ? `<button class="btn btn-primary" onclick="processVideo('${video.id}')">🔄 Try Again</button>` : ''}
        ${isProcessing ? `<button class="btn btn-danger btn-stop" onclick="stopProcessing('${video.id}')">🛑 Stop Processing</button>` : ''}
        <button class="btn btn-danger btn-sm" style="background:transparent; border:1px solid rgba(239,68,68,0.3); color:rgba(239,68,68,0.8)" onclick="deleteVideo('${video.id}')">Delete</button>
      </div>
    </div>
    ${clipsHtml}
  `;
}

async function processVideo(videoId) {
  try {
    await api.post(`/api/videos/${videoId}/process`);
    showToast('Processing started!', 'info');
    renderVideoDetail(videoId);
  } catch (err) {
    showToast('Failed to start processing: ' + err.message, 'error');
  }
}

// ---- UI State ----
let isConfirming = false;

async function deleteVideo(videoId) {
  isConfirming = true;
  const confirmed = confirm('Delete this video and all generated clips/SOPs?');
  isConfirming = false;

  if (!confirmed) return;
  try {
    await api.del(`/api/videos/${videoId}`);
    showToast('Video deleted', 'success');
    router.navigate('/');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

async function stopProcessing(videoId) {
  isConfirming = true;
  const confirmed = confirm('Stop processing this video? This will halt any ongoing AI work.');
  isConfirming = false;

  if (!confirmed) return;
  try {
    const btn = document.querySelector('.btn-stop');
    if (btn) btn.disabled = true;

    await api.post(`/api/videos/${videoId}/stop`);
    showToast('Processing stop signal sent', 'info');
    const video = await api.get(`/api/videos/${videoId}`);
    renderVideoDetailContent(video);
  } catch (err) {
    showToast('Failed to stop: ' + err.message, 'error');
  }
}

function escapeForAttr(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

// SOP Viewer
async function renderSop(clipId) {
  stopAllPolling();
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty-state"><div class="spinner" style="width:32px;height:32px;border:2px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:0 auto 1rem;"></div><p>Loading SOP...</p></div>`;

  try {
    // We need to find which video this clip belongs to
    const videos = await api.get('/api/videos');
    let video, clip;
    for (const v of videos) {
      const detail = await api.get(`/api/videos/${v.id}`);
      const found = detail.clips?.find(c => c.id === clipId);
      if (found) { video = detail; clip = found; break; }
    }

    if (!clip) { app.innerHTML = '<div class="empty-state"><p>SOP not found</p></div>'; return; }

    const steps = clip.sopSteps || [];
    const clipVideoSrc = clip.file_path ? `/data/${clip.file_path}` : null;

    // YouTube Jump Link Logic
    let youtubeJumpLink = '';
    if (video.source_url && (video.source_url.includes('youtube.com') || video.source_url.includes('youtu.be'))) {
      const baseUrl = video.source_url.split('&t=')[0].split('?t=')[0];
      const jumpUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}t=${Math.floor(clip.start_time)}`;
      youtubeJumpLink = `
        <a href="${jumpUrl}" target="_blank" class="youtube-jump-link" style="display:inline-flex; align-items:center; gap:0.5rem; color:var(--accent); text-decoration:none; font-size:0.9rem; margin-top:0.5rem; padding:0.4rem 0.8rem; background:rgba(255,255,255,0.05); border-radius:6px; transition: background 0.2s;">
          <span style="font-size:1.1rem;">📺</span> View on YouTube at ${formatDuration(clip.start_time)}
        </a>
      `;
    }

    app.innerHTML = `
      <div class="breadcrumb">
        <a href="#/">Dashboard</a>
        <span>›</span>
        <a href="#/video/${video.id}">${escapeHtml(video.title)}</a>
        <span>›</span>
        <span>SOP: ${escapeHtml(clip.title)}</span>
      </div>

      <div class="sop-header">
        <div>
          <h1>${escapeHtml(clip.title)}</h1>
          <p>${escapeHtml(clip.description || '')}</p>
          ${youtubeJumpLink}
        </div>
        <div style="display:flex; flex-direction:column; align-items:flex-end; gap:0.5rem;">
          <span class="badge badge-complete">${steps.length} steps</span>
          <button class="btn btn-secondary btn-sm" onclick="exportSop('${clip.id}')">📥 Export SOP (ZIP)</button>
        </div>
      </div>

      ${clipVideoSrc ? `
        <div class="sop-clip-player card-glass">
          <video controls preload="metadata">
            <source src="${clipVideoSrc}" type="video/mp4">
          </video>
        </div>
      ` : ''}

      <div class="sop-steps">
        ${steps.length > 0 ? steps.map(step => `
          <div class="card sop-step">
            <div class="sop-step-screenshot">
              ${step.screenshot_path
        ? `<img src="/data/${step.screenshot_path}" alt="Step ${step.step_number}">`
        : `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);">No screenshot</div>`
      }
            </div>
            <div class="sop-step-content">
              <div class="sop-step-number">Step ${step.step_number}</div>
              <div class="sop-step-instruction">${escapeHtml(step.instruction)}</div>
              ${step.code_or_prompt ? `
                <div class="sop-step-code">
                  <button class="copy-btn" onclick="copyToClipboard(this, \`${escapeForAttr(step.code_or_prompt)}\`)">Copy</button>
                  ${escapeHtml(step.code_or_prompt)}
                </div>
              ` : ''}
            </div>
          </div>
        `).join('') : '<div class="empty-state"><p>No SOP steps generated for this clip.</p></div>'}
      </div>
    `;
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><p style="color:var(--error)">Failed to load SOP: ${escapeHtml(err.message)}</p></div>`;
  }
}

function escapeForAttr(str) {
  if (!str) return '';
  return str.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');
}

function copyToClipboard(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 2000);
  }).catch(() => {
    showToast('Failed to copy', 'error');
  });
}

// Check double /api
// The current router in server.js uses app.use('/api/videos', videoRoutes);
// So the URL should be /api/videos/clips/${clipId}/export

async function exportSop(clipId) {
  try {
    showToast('Preparing export...', 'info');
    const url = `/api/videos/clips/${clipId}/export`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Export failed');

    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;

    // Try to get filename from header
    const disposition = response.headers.get('Content-Disposition');
    let filename = `sop_${clipId}.zip`;
    if (disposition && disposition.indexOf('filename=') !== -1) {
      filename = disposition.split('filename=')[1].replace(/"/g, '');
    }

    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(blobUrl);
    showToast('SOP Exported successfully!', 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  }
}

// ---- Register Routes ----
router.register('/', renderDashboard);
router.register('/upload', renderUpload);
router.register('/video/:id', renderVideoDetail);
router.register('/sop/:id', renderSop);

// ---- Init ----
async function updateProviderStatus() {
  try {
    const settings = await api.get('/api/settings');
    const container = document.getElementById('provider-status');
    if (container) {
      container.className = `provider-status ${settings.visionProvider}`;
      container.querySelector('.status-text').textContent =
        settings.visionProvider === 'local' ? 'Local Model (Qwen3-VL)' : 'Gemini Cloud';
    }
  } catch (e) {
    console.warn('Failed to fetch provider status');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  router.init();
  updateProviderStatus();
});
