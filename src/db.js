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
      CHECK(status IN ('uploaded','processing','transcribing','segmenting','generating_clips','generating_sops','complete','error','paused','scoring')),
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
    clip_id TEXT NOT NULL,
    step_number INTEGER NOT NULL,
    timestamp REAL,
    screenshot_path TEXT,
    instruction TEXT,
    code_or_prompt TEXT,
    is_hidden INTEGER DEFAULT 0,
    FOREIGN KEY (clip_id) REFERENCES clips(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_clips_video ON clips(video_id);
  CREATE INDEX IF NOT EXISTS idx_sop_clip ON sop_steps(clip_id);
`);

// Migrations: Add missing columns if they don't exist
const clipTable = db.prepare("PRAGMA table_info(clips)").all();
if (!clipTable.some(c => c.name === 'tutorial_score')) {
  db.exec("ALTER TABLE clips ADD COLUMN tutorial_score INTEGER");
}

const stepTable = db.prepare("PRAGMA table_info(sop_steps)").all();
if (!stepTable.some(c => c.name === 'is_hidden')) {
  db.exec("ALTER TABLE sop_steps ADD COLUMN is_hidden INTEGER DEFAULT 0");
}

// Migration: Fix videos status CHECK constraint (re-create table if needed)
const videosSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='videos'").get();
if (videosSchema && (!videosSchema.sql.includes("'paused'") || !videosSchema.sql.includes("'scoring'"))) {
  console.log("[DB] Migrating videos table to update status constraint (Safe Mode)...");

  // 1. Disable foreign keys temporarily
  db.exec("PRAGMA foreign_keys = OFF");

  try {
    db.transaction(() => {
      // 2. Create new table with updated schema
      db.exec(`
        CREATE TABLE videos_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT 'Untitled',
          source_type TEXT NOT NULL CHECK(source_type IN ('upload', 'youtube')),
          source_url TEXT,
          file_path TEXT,
          thumbnail_path TEXT,
          duration_seconds REAL,
          status TEXT NOT NULL DEFAULT 'uploaded'
            CHECK(status IN ('uploaded','processing','transcribing','segmenting','generating_clips','generating_sops','complete','error','paused','scoring')),
          error_message TEXT,
          transcript TEXT,
          pipeline_logs TEXT,
          video_size_mb REAL,
          estimated_finish_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // 3. Copy data
      db.exec(`
        INSERT INTO videos_new (
          id, title, source_type, source_url, file_path, thumbnail_path, 
          duration_seconds, status, error_message, transcript, 
          pipeline_logs, video_size_mb, estimated_finish_at, created_at, updated_at
        )
        SELECT 
          id, title, source_type, source_url, file_path, thumbnail_path, 
          duration_seconds, status, error_message, transcript, 
          pipeline_logs, video_size_mb, estimated_finish_at, created_at, updated_at
        FROM videos
      `);

      // 4. Drop old table
      db.exec("DROP TABLE videos");

      // 5. Rename new table to original name
      db.exec("ALTER TABLE videos_new RENAME TO videos");
    })();
    console.log("[DB] Videos table migration complete.");
  } catch (err) {
    console.error("[DB] Migration failed:", err);
    throw err;
  } finally {
    // 6. Re-enable foreign keys
    db.exec("PRAGMA foreign_keys = ON");
  }
}

// Migration: EMERGENCY REPAIR - Fix clips table if it refers to "videos_old"
const clipsSchema = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='clips'").get();
if (clipsSchema && clipsSchema.sql.includes('"videos_old"')) {
  console.log("[DB] Emergency Repair: Re-fixing clips/sop_steps foreign keys...");
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.transaction(() => {
      // 1. Recreate clips
      db.exec(`
        CREATE TABLE clips_new (
          id TEXT PRIMARY KEY,
          video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
          clip_index INTEGER NOT NULL,
          title TEXT NOT NULL,
          description TEXT,
          start_time REAL NOT NULL,
          end_time REAL NOT NULL,
          file_path TEXT,
          thumbnail_path TEXT,
          status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','complete','error')),
          tutorial_score INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.exec(`INSERT INTO clips_new (id, video_id, clip_index, title, description, start_time, end_time, file_path, thumbnail_path, status, created_at, tutorial_score)
               SELECT id, video_id, clip_index, title, description, start_time, end_time, file_path, thumbnail_path, status, created_at, tutorial_score FROM clips`);

      // 2. Recreate sop_steps
      db.exec(`
        CREATE TABLE sop_steps_new (
          id TEXT PRIMARY KEY,
          clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
          step_number INTEGER NOT NULL,
          timestamp REAL,
          screenshot_path TEXT,
          instruction TEXT,
          code_or_prompt TEXT,
          is_hidden INTEGER DEFAULT 0
        );
      `);
      db.exec(`INSERT INTO sop_steps_new 
               SELECT id, clip_id, step_number, timestamp, screenshot_path, instruction, code_or_prompt, is_hidden FROM sop_steps`);

      // 3. Swap and drop
      db.exec("DROP TABLE sop_steps");
      db.exec("DROP TABLE clips");
      db.exec("ALTER TABLE clips_new RENAME TO clips");
      db.exec("ALTER TABLE sop_steps_new RENAME TO sop_steps");
      db.exec("CREATE INDEX IF NOT EXISTS idx_clips_video ON clips(video_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_sop_clip ON sop_steps(clip_id)");
    })();
    console.log("[DB] Emergency Repair complete.");
  } catch (err) {
    console.error("[DB] Repair failed:", err);
    throw err;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
  }
}

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
  getSopStep: db.prepare(`SELECT * FROM sop_steps WHERE id = ?`),
  updateSopStep: db.prepare(`
    UPDATE sop_steps 
    SET instruction = @instruction, code_or_prompt = @codeOrPrompt 
    WHERE id = @id
  `),
  updateSopStepVisibility: db.prepare(`
    UPDATE sop_steps SET is_hidden = @isHidden WHERE id = @id
  `),
  deleteSopStep: db.prepare(`DELETE FROM sop_steps WHERE id = ?`),
};

module.exports = { db, stmts, DATA_DIR };
