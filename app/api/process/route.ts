import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { spawn } from "child_process";
import AdmZip from "adm-zip";
import crypto from "crypto";

type SettingsPayload = {
  exportFormat: "jpg" | "png" | "heic";
  createCombinedImages: boolean;
  rearPhotoLarge: boolean;
  sinceDate: string;
  endDate: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type JobStatus = "queued" | "running" | "ready" | "error";

type JobProgress = {
  stage: string;
  current: number;
  total: number;
  percent: number;
};

type Job = {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  tempDir?: string;
  downloadPath?: string;
  downloadName?: string;
  error?: string;
  createdAt: number;
  expiresAt?: number;
  exportedCount?: number;
};

const jobs = new Map<string, Job>();

const cleanupJob = async (jobId: string) => {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.tempDir) {
    await fs.rm(job.tempDir, { recursive: true, force: true });
  }
  jobs.delete(jobId);
};

const isSafeEntry = (baseDir: string, entryName: string) => {
  const resolved = path.resolve(baseDir, entryName);
  return resolved.startsWith(path.resolve(baseDir));
};

const extractZipSafely = async (
  zipBuffer: Buffer,
  destDir: string,
  onProgress?: (event: ProgressEvent) => void
) => {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();
  const totalEntries = entries.length;
  let extractedCount = 0;

  if (totalEntries > 0) {
    onProgress?.({ stage: "extracting", current: 0, total: totalEntries });
  }

  for (const entry of entries) {
    if (!entry.entryName) continue;
    if (!isSafeEntry(destDir, entry.entryName)) {
      continue;
    }

    const targetPath = path.resolve(destDir, entry.entryName);
    if (entry.isDirectory) {
      await fs.mkdir(targetPath, { recursive: true });
    } else {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, entry.getData());
    }

    extractedCount += 1;
    if (totalEntries > 0) {
      onProgress?.({
        stage: "extracting",
        current: extractedCount,
        total: totalEntries
      });
    }
  }
};

const findExportRoot = async (root: string) => {
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const maxDepth = 3;

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;

    const { dir, depth } = current;
    const postsPath = path.join(dir, "posts.json");
    const photosPath = path.join(dir, "Photos");

    try {
      const [postsStat, photosStat] = await Promise.all([
        fs.stat(postsPath).catch(() => null),
        fs.stat(photosPath).catch(() => null)
      ]);

      if (postsStat?.isFile() && photosStat?.isDirectory()) {
        return dir;
      }
    } catch {
      // ignore
    }

    if (depth >= maxDepth) {
      continue;
    }

    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) {
        queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      }
    }
  }

  return null;
};

type ProgressEvent = {
  stage?: string;
  current?: number;
  total?: number;
  exported?: number;
  percent?: number;
};

const runPython = (
  scriptPath: string,
  configPath: string,
  baseDir: string,
  onProgress?: (event: ProgressEvent) => void
) => {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, "--config", configPath, "--base-dir", baseDir], {
      cwd: baseDir,
      env: {
        ...process.env,
        BEREAL_BASE_DIR: baseDir
      }
    });

    let stdoutBuffer = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        const cleanedLine = line.replace(/^\r+/, "");
        const markerIndex = cleanedLine.indexOf("PROGRESS:");
        if (markerIndex === -1) {
          continue;
        }
        const payload = cleanedLine.slice(markerIndex + "PROGRESS:".length).trim();
        try {
          const event = JSON.parse(payload) as ProgressEvent;
          onProgress?.(event);
        } catch {
          // ignore malformed progress lines
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr || "Python processing failed."));
      }
    });
  });
};

const updateJobProgress = (job: Job, event: ProgressEvent) => {
  if (event.stage) {
    job.progress.stage = event.stage;
  }
  if (typeof event.current === "number") {
    job.progress.current = event.current;
  }
  if (typeof event.total === "number") {
    job.progress.total = event.total;
  }
  if (typeof event.percent === "number") {
    job.progress.percent = Math.max(0, Math.min(100, Math.round(event.percent)));
  }
  if (typeof event.exported === "number") {
    job.exportedCount = event.exported;
  }
  if (job.progress.total > 0) {
    job.progress.percent = Math.min(
      100,
      Math.round((job.progress.current / job.progress.total) * 100)
    );
  } else {
    job.progress.percent = job.progress.percent ?? 0;
  }
};

const setJobStage = (job: Job, stage: string, percent: number) => {
  updateJobProgress(job, {
    stage,
    percent,
    current: 0,
    total: 0
  });
};

export async function POST(request: Request) {
  const jobId = crypto.randomUUID();
  const job: Job = {
    id: jobId,
    status: "queued",
    progress: {
      stage: "queued",
      current: 0,
      total: 0,
      percent: 0
    },
    createdAt: Date.now()
  };
  jobs.set(jobId, job);

  try {
    const formData = await request.formData();
    const upload = formData.get("file");
    const settingsRaw = formData.get("settings");

    if (!upload || typeof upload === "string") {
      jobs.delete(jobId);
      return NextResponse.json({ error: "Missing zip file." }, { status: 400 });
    }

    if (!settingsRaw || typeof settingsRaw !== "string") {
      jobs.delete(jobId);
      return NextResponse.json({ error: "Missing settings payload." }, { status: 400 });
    }

    const settings = JSON.parse(settingsRaw) as SettingsPayload;
    const zipBuffer = Buffer.from(await upload.arrayBuffer());

    job.status = "running";

    void (async () => {
      let tempDir: string | undefined;
      try {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bereal-"));
        job.tempDir = tempDir;

        await extractZipSafely(zipBuffer, tempDir, (event) => updateJobProgress(job, event));
        setJobStage(job, "scanning", 10);

        const exportRoot = await findExportRoot(tempDir);
        if (!exportRoot) {
          job.status = "error";
          job.error = "Could not find posts.json and Photos folder inside the zip.";
          await fs.rm(tempDir, { recursive: true, force: true });
          job.tempDir = undefined;
          job.expiresAt = Date.now() + 30 * 60 * 1000;
          setTimeout(() => {
            void cleanupJob(job.id);
          }, 30 * 60 * 1000);
          return;
        }

        setJobStage(job, "configuring", 15);
        const configPath = path.join(tempDir, "config.json");
        const deleteSinglesAfterCombining = settings.createCombinedImages;
        const configPayload = {
          export_format: settings.exportFormat,
          keep_original_filename: false,
          create_combined_images: settings.createCombinedImages,
          rear_photo_large: settings.rearPhotoLarge,
          delete_processed_files_after_combining: deleteSinglesAfterCombining,
          use_verbose_logging: false,
          since_date: settings.sinceDate || null,
          until_date: settings.endDate || null
        };

        await fs.writeFile(configPath, JSON.stringify(configPayload, null, 2));
        setJobStage(job, "processing", 20);

        const scriptPath = path.join(process.cwd(), "bereal-process-photos.py");
        await runPython(scriptPath, configPath, exportRoot, (event) =>
          updateJobProgress(job, event)
        );

        setJobStage(job, "packaging", 90);

        const outputEntries = await fs.readdir(exportRoot, { withFileTypes: true });
        const outputDirs = outputEntries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("__"))
          .map((entry) => entry.name);

        if (outputDirs.length === 0) {
          job.status = "error";
          job.error = "Processing finished but no output folders were created.";
          await fs.rm(tempDir, { recursive: true, force: true });
          job.tempDir = undefined;
          job.expiresAt = Date.now() + 30 * 60 * 1000;
          setTimeout(() => {
            void cleanupJob(job.id);
          }, 30 * 60 * 1000);
          return;
        }

        const exportDate = new Date().toISOString().slice(0, 10);
        const exportBaseName = `${exportDate}_BeReal–Processing_Export`;
        const bundleDir = path.join(tempDir, exportBaseName);
        await fs.mkdir(bundleDir, { recursive: true });

        if (outputDirs.length === 1) {
          const srcDir = path.join(exportRoot, outputDirs[0]);
          const entries = await fs.readdir(srcDir);
          for (const entry of entries) {
            await fs.rename(path.join(srcDir, entry), path.join(bundleDir, entry));
          }
          await fs.rm(srcDir, { recursive: true, force: true });
        } else {
          for (const dir of outputDirs) {
            await fs.rename(path.join(exportRoot, dir), path.join(bundleDir, dir));
          }
        }

        const outputZip = new AdmZip();
        outputZip.addLocalFolder(bundleDir, exportBaseName);

        const outputZipPath = path.join(tempDir, `${exportBaseName}.zip`);
        setJobStage(job, "packaging", 96);
        const outputBuffer = outputZip.toBuffer();
        await fs.writeFile(outputZipPath, outputBuffer);
        setJobStage(job, "packaging", 99);

        job.downloadPath = outputZipPath;
        job.downloadName = `${exportBaseName}.zip`;
        job.status = "ready";
        job.progress = {
          stage: "complete",
          current: 1,
          total: 1,
          percent: 100
        };
        job.expiresAt = Date.now() + 30 * 60 * 1000;
        setTimeout(() => {
          void cleanupJob(job.id);
        }, 30 * 60 * 1000);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unexpected error.";
        job.status = "error";
        job.error = message;
        if (tempDir) {
          await fs.rm(tempDir, { recursive: true, force: true });
        }
        job.expiresAt = Date.now() + 30 * 60 * 1000;
        setTimeout(() => {
          void cleanupJob(job.id);
        }, 30 * 60 * 1000);
      }
    })();

    return NextResponse.json({ jobId });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    jobs.delete(jobId);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const jobId = searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "Missing jobId." }, { status: 400 });
  }

  const job = jobs.get(jobId);
  if (!job) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }

  if (searchParams.get("download") === "1") {
    if (job.status !== "ready" || !job.downloadPath) {
      return NextResponse.json({ error: "File not ready." }, { status: 409 });
    }
    const buffer = await fs.readFile(job.downloadPath);
    const filename = job.downloadName ?? "bereal-processed.zip";
    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=${filename}`
      }
    });
  }

  return NextResponse.json({
    status: job.status,
    stage: job.progress.stage,
    current: job.progress.current,
    total: job.progress.total,
    percent: job.progress.percent,
    error: job.error ?? null,
    exportedCount: job.exportedCount ?? null,
    downloadName: job.downloadName ?? null,
    downloadUrl:
      job.status === "ready" ? `/api/process?jobId=${job.id}&download=1` : null
  });
}
