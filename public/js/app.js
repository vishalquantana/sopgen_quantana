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
    paused: 'Paused',
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
  register(path, handler) { this.routes[patternToRegex(path)] = handler; },
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
    for (const [regex, handler] of Object.entries(this.routes)) {
      const match = hash.match(new RegExp(regex));
      if (match) {
        handler(...match.slice(1));
        return;
      }
    }
    // Fallback
    renderDashboard();
  },
};
function patternToRegex(pattern) {
  return '^' + pattern.replace(/:\w+/g, '([^/]+)') + '$';
}

// ---- Polling Manager ----
let activePolls = {};
let isConfirming = false; // Global flag to block polling re-renders

async function poll(videoId, callback, interval = 3000, errorCount = 0) {
  if (!activePolls[videoId]) return;

  // Wait if user is confirming something
  if (isConfirming) {
    activePolls[videoId] = setTimeout(() => poll(videoId, callback, interval, errorCount), 1000);
    return;
  }

  try {
    const shouldContinue = await callback();
    if (activePolls[videoId] && shouldContinue) {
      activePolls[videoId] = setTimeout(() => poll(videoId, callback, interval, 0), interval);
    }
  } catch (err) {
    console.error(`Poll error [${videoId}]:`, err);
    errorCount++;
    // Exponential backoff
    const nextInterval = Math.min(interval * Math.pow(2, errorCount), 30000);
    if (activePolls[videoId]) {
      activePolls[videoId] = setTimeout(() => poll(videoId, callback, interval, errorCount), nextInterval);
    }
  }
}

function startPolling(videoId, callback, interval = 3000) {
  stopPolling(videoId);
  activePolls[videoId] = true; // Placeholder
  poll(videoId, callback, interval);
}

function stopPolling(videoId) {
  if (activePolls[videoId]) {
    clearTimeout(activePolls[videoId]);
    delete activePolls[videoId];
  }
}

function stopAllPolling() {
  Object.keys(activePolls).forEach(stopPolling);
}

// ---- Views ----

// Dashboard
async function renderDashboard() {
  stopAllPolling();
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

  // Initialize Listeners
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
      container.innerHTML = `<div class="empty-state"><div class="empty-state-icon">🎬</div><h3>No videos yet</h3><p>Start by uploading above!</p></div>`;
      return;
    }

    container.innerHTML = `<div class="video-grid">${videos.map(v => videoCard(v)).join('')}</div>`;

    // Start polling for active ones
    videos.filter(v => ['processing', 'transcribing', 'segmenting', 'generating_clips', 'generating_sops'].includes(v.status)).forEach(v => {
      startPolling(v.id, async () => {
        const updated = await api.get(`/api/videos/${v.id}`);
        const card = document.querySelector(`[data-video-id="${v.id}"]`);
        if (card) card.outerHTML = videoCard(updated);
        return !['complete', 'error', 'paused'].includes(updated.status);
      });
    });
  } catch (err) {
    document.getElementById('video-list').innerHTML = `<p style="color:var(--error); text-align:center;">Failed to load: ${escapeHtml(err.message)}</p>`;
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
  const p = document.getElementById('upload-progress');
  p.style.display = 'block';
  document.getElementById('upload-file-name').textContent = file.name;
  const formData = new FormData();
  formData.append('video', file);
  formData.append('title', file.name.replace(/\.[^/.]+$/, ''));
  try {
    const res = await api.upload('/api/videos/upload', formData, (pct) => {
      document.getElementById('upload-percent').textContent = pct + '%';
      document.getElementById('upload-bar').style.width = pct + '%';
    });
    router.navigate(`/video/${res.id}`);
  } catch (e) { showToast(e.message, 'error'); p.style.display = 'none'; }
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
  app.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>Loading video...</p></div>`;

  try {
    const video = await api.get(`/api/videos/${videoId}`);
    renderVideoDetailContent(video);

    if (!['uploaded', 'complete', 'error', 'paused'].includes(video.status)) {
      startPolling(videoId, async () => {
        const updated = await api.get(`/api/videos/${videoId}`);
        renderVideoDetailContent(updated);
        return !['uploaded', 'complete', 'error', 'paused'].includes(updated.status);
      });
    }
  } catch (err) {
    app.innerHTML = `<div class="empty-state"><p style="color:var(--error)">${escapeHtml(err.message)}</p><br><a href="#/" class="btn btn-secondary">← Back</a></div>`;
  }
}

function renderVideoDetailContent(video) {
  // Prevent re-rendering while user is in a modal/confirm
  if (isConfirming) return;

  const app = document.getElementById('app');
  const isProcessing = ['processing', 'transcribing', 'segmenting', 'generating_clips', 'generating_sops'].includes(video.status);
  const clips = video.clips || [];

  let clipsHtml = '';
  if (isProcessing || video.status === 'paused') {
    const statusMessages = {
      processing: 'Preparing video...',
      transcribing: 'Transcribing audio...',
      segmenting: 'Segmenting topics...',
      generating_clips: 'Generating clips...',
      generating_sops: 'Creating SOPs...',
      paused: 'Processing paused.',
    };

    const logs = (video.pipeline_logs || '').split('\n').filter(Boolean).slice(-8).reverse();

    clipsHtml = `
      <div class="card processing-status">
        <div class="${video.status === 'paused' ? '' : 'spinner'}"></div>
        <h3>${statusMessages[video.status] || 'Processing...'}</h3>
        ${video.estimated_finish_at && video.status !== 'paused' ? `
          <div class="estimate-badge">Roughly ${Math.ceil((new Date(video.estimated_finish_at) - Date.now()) / 60000)}m remaining</div>
        ` : ''}
        <div class="pipeline-logs">
          ${logs.map(log => `<div class="log-entry">${escapeHtml(log)}</div>`).join('')}
        </div>
      </div>
    `;
  }

  // Show clips even during processing (Real-time queue)
  if (clips.length > 0) {
    clipsHtml += `
      <div class="clips-section">
        <h2>${video.status === 'complete' ? '' : 'In-Progress '}Clips & SOPs (${clips.length})</h2>
        <div class="clip-list">
          ${clips.map(clip => `
            <div class="card clip-item" onclick="router.navigate('/sop/${clip.id}')">
              <div class="clip-number">${clip.clip_index}</div>
              <div class="clip-info">
                <h3>${escapeHtml(clip.title)}</h3>
                <span class="clip-time">${formatDuration(clip.start_time)} → ${formatDuration(clip.end_time)}</span>
                <div style="margin-top:0.4rem;">
                    ${clip.tutorial_score !== null ? `<span style="font-size:0.8rem; color:var(--accent); font-weight:600;">🎓 ${clip.tutorial_score}% Tutorial Score</span>` : ''}
                </div>
              </div>
              <span class="badge badge-${clip.status}">${clip.sopSteps?.length || 0} steps</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  app.innerHTML = `
    <div class="breadcrumb"><a href="#/">Dashboard</a> <span>›</span> ${escapeHtml(video.title)}</div>
    <div class="detail-header">
      <h1>${escapeHtml(video.title)}</h1>
      <div class="detail-meta">
        <span class="badge badge-${video.status}">${statusLabel(video.status)}</span>
        <span>⏱ ${formatDuration(video.duration_seconds)}</span>
        <span>${formatDate(video.created_at)}</span>
      </div>
      <div class="detail-actions">
        ${video.status === 'uploaded' ? `<button class="btn btn-primary" onclick="processVideo('${video.id}')">🚀 Start</button>` : ''}
        ${video.status === 'paused' ? `<button class="btn btn-primary" onclick="resumeVideo('${video.id}')">▶ Resume</button>` : ''}
        ${video.status === 'error' ? `<button class="btn btn-primary" onclick="processVideo('${video.id}')">🔄 Retry</button>` : ''}
        ${isProcessing ? `<button class="btn btn-danger" onclick="pauseVideo('${video.id}')">⏸ Pause</button>` : ''}
        <button class="btn btn-danger btn-sm" style="opacity:0.6;" onclick="deleteVideo('${video.id}')">Delete</button>
      </div>
    </div>
    ${clipsHtml}
  `;
}

// Handlers
async function processVideo(id) {
  try { await api.post(`/api/videos/${id}/process`); showToast('Processing started', 'info'); renderVideoDetail(id); }
  catch (e) { showToast(e.message, 'error'); }
}
async function pauseVideo(id) {
  isConfirming = true;
  if (!confirm('Pause processing? You can resume later.')) { isConfirming = false; return; }
  isConfirming = false;
  try { await api.post(`/api/videos/${id}/pause`); showToast('Paused', 'info'); renderVideoDetail(id); }
  catch (e) { showToast(e.message, 'error'); }
}
async function resumeVideo(id) {
  try { await api.post(`/api/videos/${id}/resume`); showToast('Resuming...', 'info'); renderVideoDetail(id); }
  catch (e) { showToast(e.message, 'error'); }
}
async function deleteVideo(id) {
  isConfirming = true;
  if (!confirm('Delete this video forever?')) { isConfirming = false; return; }
  isConfirming = false;
  try { await api.del(`/api/videos/${id}`); showToast('Deleted', 'success'); router.navigate('/'); }
  catch (e) { showToast(e.message, 'error'); }
}

// SOP Viewer
async function renderSop(clipId) {
  stopAllPolling();
  const app = document.getElementById('app');
  app.innerHTML = `<div class="empty-state"><div class="spinner"></div><p>Loading SOP...</p></div>`;

  try {
    const videos = await api.get('/api/videos');
    let video, clip;
    for (const v of videos) {
      const detail = await api.get(`/api/videos/${v.id}`);
      const found = detail.clips?.find(c => c.id === clipId);
      if (found) { video = detail; clip = found; break; }
    }
    if (!clip) { router.navigate('/'); return; }

    const steps = clip.sopSteps || [];
    const jumpUrl = video.source_url ? `${video.source_url.split(/[&?][t]=/)[0]}${video.source_url.includes('?') ? '&' : '?'}t=${Math.floor(clip.start_time)}` : null;

    app.innerHTML = `
      <div class="breadcrumb"><a href="#/">Dashboard</a> <span>›</span> <a href="#/video/${video.id}">${escapeHtml(video.title)}</a> <span>›</span> SOP</div>
      <div class="sop-header">
        <div>
          <h1>${escapeHtml(clip.title)}</h1>
          <p>${escapeHtml(clip.description || '')}</p>
          ${jumpUrl ? `<a href="${jumpUrl}" target="_blank" class="youtube-jump-link">📺 View on YouTube at ${formatDuration(clip.start_time)}</a>` : ''}
        </div>
        <div style="text-align:right">
          <div style="margin-bottom:0.5rem">
            ${clip.tutorial_score !== null ? `<span class="badge" style="background:var(--accent); color:white">${clip.tutorial_score}% Tutorial Match</span>` : ''}
          </div>
          <button class="btn btn-secondary btn-sm" onclick="exportSop('${clip.id}')">📥 Export ZIP</button>
        </div>
      </div>

      ${clip.file_path ? `<div class="sop-clip-player card-glass"><video controls><source src="/data/${clip.file_path}" type="video/mp4"></video></div>` : ''}

      <div class="sop-steps">
        ${steps.map(step => `
          <div class="card sop-step">
            <div class="sop-step-screenshot">
              ${step.screenshot_path ? `<img src="/data/${step.screenshot_path}">` : 'No Image'}
            </div>
            <div class="sop-step-content">
              <div class="sop-step-number">Step ${step.step_number}</div>
              <div class="sop-step-instruction">${escapeHtml(step.instruction)}</div>
              ${step.code_or_prompt ? `
                <div class="sop-step-code">
                  <button class="copy-btn" onclick="copyToClipboard(this, \`${step.code_or_prompt.replace(/`/g, '\\`')}\`)">Copy</button>
                  ${escapeHtml(step.code_or_prompt)}
                </div>
              ` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (e) { showToast(e.message, 'error'); }
}

function copyToClipboard(btn, text) {
  navigator.clipboard.writeText(text).then(() => {
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = 'Copy', 2000);
  });
}

async function exportSop(clipId) {
  showToast('Preparing ZIP...', 'info');
  try {
    const res = await fetch(`/api/videos/clips/${clipId}/export`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sop_${clipId}.zip`;
    a.click();
    showToast('Export successful!', 'success');
  } catch (e) { showToast('Export failed', 'error'); }
}

async function updateProviderStatus() {
  try {
    const s = await api.get('/api/settings');
    const c = document.getElementById('provider-status');
    if (c) {
      c.className = `provider-status ${s.visionProvider}`;
      c.querySelector('.status-text').textContent = s.visionProvider === 'local' ? 'Local Model (Qwen3-VL)' : 'Gemini Cloud';
    }
  } catch (e) { }
}

// ---- Register Routes ----
router.register('/', renderDashboard);
router.register('/upload', renderUpload);
router.register('/video/:id', renderVideoDetail);
router.register('/sop/:id', renderSop);

// ---- Init ----
document.addEventListener('DOMContentLoaded', () => {
  router.init();
  updateProviderStatus();
});
