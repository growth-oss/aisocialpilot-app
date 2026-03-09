'use strict';
// ─── Backup Module ───────────────────────────────────────────────────────────
// Handles: zip creation (tar), AES-256-GCM encryption, R2/S3 upload, retention
// All paths resolved relative to DATA_DIR passed in at call time.
// No dependencies beyond @aws-sdk/client-s3 (for R2 upload only).
// Uses system `tar` (always present in the Playwright Docker base image).

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

// ─── Status file ─────────────────────────────────────────────────────────────

function statusFile(dataDir) {
  return path.join(dataDir, 'backup-status.json');
}

function loadStatus(dataDir) {
  try { return JSON.parse(fs.readFileSync(statusFile(dataDir), 'utf8')); } catch { return {}; }
}

function saveStatus(dataDir, s) {
  fs.writeFileSync(statusFile(dataDir), JSON.stringify(s, null, 2));
}

// ─── R2 config check ─────────────────────────────────────────────────────────

function isR2Configured() {
  return !!(
    process.env.BACKUP_R2_ENDPOINT &&
    process.env.BACKUP_R2_ACCESS_KEY_ID &&
    process.env.BACKUP_R2_SECRET_ACCESS_KEY &&
    process.env.BACKUP_R2_BUCKET
  );
}

function makeS3Client() {
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({
    region: 'auto',
    endpoint: process.env.BACKUP_R2_ENDPOINT,
    credentials: {
      accessKeyId:     process.env.BACKUP_R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.BACKUP_R2_SECRET_ACCESS_KEY,
    },
  });
}

// ─── Archive creation via tar ─────────────────────────────────────────────────
// Excludes screenshots (large + re-generable) and any stray node_modules.
// Browser sessions ARE included — these are the hardest thing to recreate.

function createArchive(dataDir) {
  const tmpPath = `/tmp/sp-backup-${Date.now()}.tar.gz`;
  // Build exclusion list — paths are relative to dataDir
  const excludes = [
    '--exclude=./*/logs/screenshots',
    '--exclude=./logs/screenshots',
    '--exclude=./**/node_modules',
    '--exclude=./backup-status.json',
  ].join(' ');
  execSync(`tar -czf "${tmpPath}" ${excludes} -C "${dataDir}" .`, {
    timeout: 180000, // 3 minutes max
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return tmpPath;
}

// ─── AES-256-GCM encryption ───────────────────────────────────────────────────
// Wire format: salt(16) | iv(12) | authTag(16) | ciphertext
// Password → key via scrypt (memory-safe KDF).

function encryptFile(inputPath, password) {
  const outputPath = inputPath + '.enc';
  const salt = crypto.randomBytes(16);
  const iv   = crypto.randomBytes(12);
  const key  = crypto.scryptSync(password, salt, 32);

  const cipher    = crypto.createCipheriv('aes-256-gcm', key, iv);
  const input     = fs.readFileSync(inputPath);
  const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
  const tag       = cipher.getAuthTag();

  fs.writeFileSync(outputPath, Buffer.concat([salt, iv, tag, encrypted]));
  fs.unlinkSync(inputPath);
  return outputPath;
}

function decryptBuffer(buf, password) {
  const salt      = buf.slice(0, 16);
  const iv        = buf.slice(16, 28);
  const tag       = buf.slice(28, 44);
  const encrypted = buf.slice(44);
  const key       = crypto.scryptSync(password, salt, 32);

  const decipher  = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// ─── R2 upload ───────────────────────────────────────────────────────────────

async function uploadToR2(filePath) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const client   = makeS3Client();
  const now      = new Date();
  const dateStr  = now.toISOString().slice(0, 10);
  const isWeekly = now.getDay() === 0; // Sunday = weekly snapshot
  const password = process.env.BACKUP_ENCRYPT_PASSWORD;
  const ext      = password ? '.tar.gz.enc' : '.tar.gz';
  const prefix   = isWeekly ? 'weekly' : 'daily';
  const key      = `${prefix}/backup-${dateStr}${ext}`;
  const stat     = fs.statSync(filePath);

  await client.send(new PutObjectCommand({
    Bucket:      process.env.BACKUP_R2_BUCKET,
    Key:         key,
    Body:        fs.readFileSync(filePath),
    ContentType: 'application/octet-stream',
    Metadata: {
      sizeBytes: String(stat.size),
      createdAt: now.toISOString(),
    },
  }));

  return { key, sizeBytes: stat.size };
}

// ─── Retention cleanup ────────────────────────────────────────────────────────
// Keep 7 daily + 4 weekly backups, delete anything older.

async function pruneOldBackups() {
  if (!isR2Configured()) return;
  const { ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
  const client = makeS3Client();

  const res = await client.send(new ListObjectsV2Command({
    Bucket: process.env.BACKUP_R2_BUCKET,
  }));

  const objects = (res.Contents || []).sort(
    (a, b) => new Date(b.LastModified) - new Date(a.LastModified)
  );

  const daily  = objects.filter(o => o.Key.startsWith('daily/'));
  const weekly = objects.filter(o => o.Key.startsWith('weekly/'));
  const toDelete = [...daily.slice(7), ...weekly.slice(4)];

  for (const obj of toDelete) {
    await client.send(new DeleteObjectCommand({
      Bucket: process.env.BACKUP_R2_BUCKET,
      Key: obj.Key,
    }));
    console.log(`[backup] Pruned: ${obj.Key}`);
  }
}

// ─── Main backup runner ───────────────────────────────────────────────────────

async function runBackup(dataDir) {
  const startedAt = new Date().toISOString();
  console.log('[backup] Starting backup...');
  let archivePath = null;

  try {
    // 1. Create tar.gz
    archivePath = createArchive(dataDir);
    let sizeBytes = fs.statSync(archivePath).size;
    console.log(`[backup] Archive: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB`);

    // 2. Encrypt if password configured
    const password = process.env.BACKUP_ENCRYPT_PASSWORD;
    if (password) {
      archivePath = encryptFile(archivePath, password);
      sizeBytes   = fs.statSync(archivePath).size;
      console.log('[backup] Encrypted');
    }

    // 3. Upload to R2 if configured
    let uploadedKey = null;
    if (isR2Configured()) {
      const result = await uploadToR2(archivePath);
      uploadedKey  = result.key;
      sizeBytes    = result.sizeBytes;
      console.log(`[backup] Uploaded → ${uploadedKey}`);
      await pruneOldBackups();
    } else {
      console.log('[backup] R2 not configured — archive created locally only');
    }

    // 4. Clean up temp file
    try { fs.unlinkSync(archivePath); } catch {}

    // 5. Persist status
    const status = {
      lastBackupAt:       startedAt,
      lastBackupSuccess:  true,
      lastBackupSizeBytes: sizeBytes,
      lastBackupKey:      uploadedKey,
      r2Configured:       isR2Configured(),
    };
    saveStatus(dataDir, status);
    console.log('[backup] Done');
    return status;

  } catch (err) {
    console.error('[backup] Failed:', err.message);
    try { if (archivePath) fs.unlinkSync(archivePath); } catch {}

    const status = {
      ...loadStatus(dataDir),
      lastBackupAt:      startedAt,
      lastBackupSuccess: false,
      lastBackupError:   err.message,
      r2Configured:      isR2Configured(),
    };
    saveStatus(dataDir, status);
    throw err;
  }
}

// ─── Create download archive (manual export, streams to browser) ───────────────

function createDownloadArchive(dataDir) {
  const tmpPath = `/tmp/sp-export-${Date.now()}.tar.gz`;
  const excludes = [
    '--exclude=./*/logs/screenshots',
    '--exclude=./logs/screenshots',
    '--exclude=./**/node_modules',
  ].join(' ');
  execSync(`tar -czf "${tmpPath}" ${excludes} -C "${dataDir}" .`, {
    timeout: 180000,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  return tmpPath;
}

// ─── Restore from uploaded file ───────────────────────────────────────────────
// Accepts a Buffer (from multipart upload or raw body).
// If encrypted, decrypts first. Then extracts into dataDir.

function restoreFromBuffer(buf, dataDir) {
  const password = process.env.BACKUP_ENCRYPT_PASSWORD;
  let tarBuf = buf;

  // Detect encryption by checking if password is set and trying to decrypt.
  // We sniff by trying — if it fails, it was not encrypted.
  if (password) {
    try {
      tarBuf = decryptBuffer(buf, password);
    } catch {
      // Not encrypted — use as-is
      tarBuf = buf;
    }
  }

  const tmpTar = `/tmp/sp-restore-${Date.now()}.tar.gz`;
  fs.writeFileSync(tmpTar, tarBuf);

  try {
    execSync(`tar -xzf "${tmpTar}" -C "${dataDir}"`, {
      timeout: 300000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } finally {
    try { fs.unlinkSync(tmpTar); } catch {}
  }

  return { success: true };
}

module.exports = {
  runBackup,
  createDownloadArchive,
  restoreFromBuffer,
  loadStatus,
  isR2Configured,
};
