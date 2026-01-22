import { NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { spawn } from "child_process";
import AdmZip from "adm-zip";

type SettingsPayload = {
  convertToJpeg: boolean;
  keepOriginalFilename: boolean;
  createCombinedImages: boolean;
  deleteProcessedFilesAfterCombining: boolean;
  verboseLogging: boolean;
  sinceDate: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isSafeEntry = (baseDir: string, entryName: string) => {
  const resolved = path.resolve(baseDir, entryName);
  return resolved.startsWith(path.resolve(baseDir));
};

const extractZipSafely = async (zipBuffer: Buffer, destDir: string) => {
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries();

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

const runPython = (scriptPath: string, configPath: string, baseDir: string) => {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn("python3", [scriptPath, "--config", configPath, "--base-dir", baseDir], {
      cwd: baseDir,
      env: {
        ...process.env,
        BEREAL_BASE_DIR: baseDir
      }
    });

    let stderr = "";
    proc.stdout.on("data", () => {
      // swallow stdout to avoid buffering issues
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

export async function POST(request: Request) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bereal-"));

  try {
    const formData = await request.formData();
    const upload = formData.get("file");
    const settingsRaw = formData.get("settings");

    if (!upload || typeof upload === "string") {
      return NextResponse.json({ error: "Missing zip file." }, { status: 400 });
    }

    if (!settingsRaw || typeof settingsRaw !== "string") {
      return NextResponse.json({ error: "Missing settings payload." }, { status: 400 });
    }

    const settings = JSON.parse(settingsRaw) as SettingsPayload;

    const zipBuffer = Buffer.from(await upload.arrayBuffer());
    await extractZipSafely(zipBuffer, tempDir);

    const exportRoot = await findExportRoot(tempDir);
    if (!exportRoot) {
      return NextResponse.json({
        error: "Could not find posts.json and Photos folder inside the zip."
      }, { status: 400 });
    }

    const configPath = path.join(tempDir, "config.json");
    const configPayload = {
      convert_to_jpeg: settings.convertToJpeg,
      keep_original_filename: settings.keepOriginalFilename,
      create_combined_images: settings.createCombinedImages,
      delete_processed_files_after_combining: settings.deleteProcessedFilesAfterCombining,
      use_verbose_logging: settings.verboseLogging,
      since_date: settings.sinceDate || null
    };

    await fs.writeFile(configPath, JSON.stringify(configPayload, null, 2));

    const scriptPath = path.join(process.cwd(), "bereal-process-photos.py");
    await runPython(scriptPath, configPath, exportRoot);

    const outputEntries = await fs.readdir(exportRoot, { withFileTypes: true });
    const outputDirs = outputEntries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("__"))
      .map((entry) => entry.name);

    if (outputDirs.length === 0) {
      return NextResponse.json({
        error: "Processing finished but no output folders were created."
      }, { status: 500 });
    }

    const outputZip = new AdmZip();
    for (const dir of outputDirs) {
      outputZip.addLocalFolder(path.join(exportRoot, dir), dir);
    }

    const buffer = outputZip.toBuffer();

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": "attachment; filename=bereal-processed.zip"
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
