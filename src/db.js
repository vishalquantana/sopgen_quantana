const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'sopgen.db');

// Ensure data directories exist
const dirs = ['uploads', 'clips', 'screenshots', 'audio', 'thumbnails', 'sops'];
dirs.forEach(d => fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Schema ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'Untitled',
    source_type TEXT NOT NULL CHECK(source_type IN ('upload', 'youtube')),
    source_url TEXT,
    file_path TEXT,
    thumbnail_path TEXT,
    duration_seconds REAL,
    status TEXT NOT NULL DEFAULT 'uploaded'
      CHECK(status IN ('uploaded','processing','transcribing','segmenting','generating_clips','generating_sops','complete','error','paused')),
    error_message TEXT,
    transcript TEXT,
    pipeline_logs TEXT,
    video_size_mb REAL,
    estimated_finish_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clips (
    id TEXT PRIMARY KEY,
    video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
    clip_index INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    start_time REAL NOT NULL,
    end_time REAL NOT NULL,
    file_path TEXT,
    thumbnail_path TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','processing','complete','error')),
    tutorial_score INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sop_steps (
    id TEXT PRIMARY KEY,
    clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
    step_number INTEGER NOT NULL,
    timestamp REAL,
    screenshot_path TEXT,
    instruction TEXT NOT NULL,
    code_or_prompt TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_clips_video ON clips(video_id);
  CREATE INDEX IF NOT EXISTS idx_sop_clip ON sop_steps(clip_id);
`);

// ---------- Helpers ----------

const stmts = {
  // Videos
  insertVideo: db.prepare(`
    INSERT INTO videos (id, title, source_type, source_url, file_path, duration_seconds)
    VALUES (@id, @title, @sourceType, @sourceUrl, @filePath, @durationSeconds)
  `),
  getVideo: db.prepare(`SELECT * FROM videos WHERE id = ?`),
  listVideos: db.prepare(`SELECT * FROM videos ORDER BY created_at DESC`),
  updateVideoStatus: db.prepare(`
    UPDATE videos SET status = @status, updated_at = datetime('now') WHERE id = @id
  `),
  updateVideoError: db.prepare(`
    UPDATE videos SET status = 'error', error_message = @errorMessage, updated_at = datetime('now') WHERE id = @id
  `),
  updateVideoTranscript: db.prepare(`
    UPDATE videos SET transcript = @transcript, updated_at = datetime('now') WHERE id = @id
  `),
  updateVideoMeta: db.prepare(`
    UPDATE videos SET title = @title, duration_seconds = @durationSeconds, thumbnail_path = @thumbnailPath, updated_at = datetime('now') WHERE id = @id
  `),
  updateVideoSize: db.prepare(`
    UPDATE videos SET video_size_mb = @sizeMb, updated_at = datetime('now') WHERE id = @id
  `),
  addPipelineLog: db.prepare(`
    UPDATE videos SET 
      pipeline_logs = CASE 
        WHEN pipeline_logs IS NULL THEN @message 
        ELSE pipeline_logs || CHAR(10) || @message 
      END,
      updated_at = datetime('now')
    WHERE id = @id
  `),
  updateVideoEstimate: db.prepare(`
    UPDATE videos SET estimated_finish_at = @estimateAt, updated_at = datetime('now') WHERE id = @id
  `),

  // Clips
  insertClip: db.prepare(`
    INSERT INTO clips (id, video_id, clip_index, title, description, start_time, end_time)
    VALUES (@id, @videoId, @clipIndex, @title, @description, @startTime, @endTime)
  `),
  getClipsByVideo: db.prepare(`SELECT * FROM clips WHERE video_id = ? ORDER BY clip_index`),
  getClip: db.prepare(`SELECT * FROM clips WHERE id = ?`),
  updateClipFile: db.prepare(`
    UPDATE clips SET file_path = @filePath, thumbnail_path = @thumbnailPath, status = 'complete' WHERE id = @id
  `),
  updateClipStatus: db.prepare(`
    UPDATE clips SET status = @status WHERE id = @id
  `),
  updateClipScore: db.prepare(`
    UPDATE clips SET tutorial_score = @score WHERE id = @id
  `),

  // SOP Steps
  insertSopStep: db.prepare(`
    INSERT INTO sop_steps (id, clip_id, step_number, timestamp, screenshot_path, instruction, code_or_prompt)
    VALUES (@id, @clipId, @stepNumber, @timestamp, @screenshotPath, @instruction, @codeOrPrompt)
  `),
  getSopStepsByClip: db.prepare(`SELECT * FROM sop_steps WHERE clip_id = ? ORDER BY step_number`),
};

module.exports = { db, stmts, DATA_DIR };
