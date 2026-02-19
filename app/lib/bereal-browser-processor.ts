import JSZip, { type JSZipObject } from "jszip";
import piexif from "piexifjs";

export type ProcessorSettings = {
  exportFormat: "jpg" | "png" | "heic";
  createCombinedImages: boolean;
  rearPhotoLarge: boolean;
  sinceDate: string;
  endDate: string;
};

export type ProcessorProgress = {
  stage: "scanning" | "processing" | "combining" | "packaging" | "complete";
  current: number;
  total: number;
  percent: number;
};

export type ProcessorResult = {
  blob: Blob;
  filename: string;
  exportedCount: number;
  warnings: string[];
  effectiveFormat: "jpg" | "png";
};

type PostLocation = {
  latitude?: number;
  longitude?: number;
};

type PostPayload = {
  takenAt?: string;
  primary?: {
    path?: string;
  };
  secondary?: {
    path?: string;
  };
  location?: PostLocation;
  caption?: string;
};

type ParsedPost = {
  entry: PostPayload;
  takenAt: Date;
};

type OutputFile = {
  name: string;
  blob: Blob;
};

type ProcessedPair = {
  primary: OutputFile;
  secondary: OutputFile;
  takenAt: Date;
  location?: { latitude: number; longitude: number };
  caption?: string;
};

const COMBINED_OVERLAY_SCALE = 1 / 3.33333333;
const COMBINED_CORNER_RADIUS = 60;
const COMBINED_OUTLINE_SIZE = 7;
const COMBINED_POSITION = { x: 55, y: 55 };

const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "");

const basename = (value: string) => {
  const normalized = normalizePath(value).replace(/\/+$/, "");
  const parts = normalized.split("/");
  return parts[parts.length - 1] ?? normalized;
};

const pad = (value: number) => String(value).padStart(2, "0");

const formatDateUtc = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

const formatTimestampUtc = (date: Date) =>
  `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours()
  )}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}`;

const formatExifDateTimeUtc = (date: Date) =>
  `${date.getUTCFullYear()}:${pad(date.getUTCMonth() + 1)}:${pad(date.getUTCDate())} ${pad(
    date.getUTCHours()
  )}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;

const toExifDegrees = (value: number): [[number, number], [number, number], [number, number]] => {
  const degrees = Math.floor(value);
  const minutesFloat = (value - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = (value - degrees - minutes / 60) * 3600;
  return [
    [degrees, 1],
    [minutes, 1],
    [Math.round(seconds * 100), 100]
  ];
};

const buildFileLookup = (
  zip: JSZip
): {
  byPath: Map<string, JSZipObject>;
  byBasename: Map<string, JSZipObject[]>;
} => {
  const byPath = new Map<string, JSZipObject>();
  const byBasename = new Map<string, JSZipObject[]>();

  for (const zipObject of Object.values(zip.files)) {
    if (zipObject.dir) {
      continue;
    }
    const normalizedPath = normalizePath(zipObject.name);
    const lowerPath = normalizedPath.toLowerCase();
    byPath.set(lowerPath, zipObject);

    const lowerBase = basename(normalizedPath).toLowerCase();
    const existing = byBasename.get(lowerBase);
    if (existing) {
      existing.push(zipObject);
    } else {
      byBasename.set(lowerBase, [zipObject]);
    }
  }

  return { byPath, byBasename };
};

const findExportRootPrefix = (zip: JSZip) => {
  const paths = Object.keys(zip.files).map(normalizePath);
  const postsCandidates = paths.filter((value) => value.toLowerCase().endsWith("posts.json"));

  for (const candidate of postsCandidates) {
    const prefix = candidate.slice(0, candidate.length - "posts.json".length);
    const photosPrefix = `${prefix}Photos/`.toLowerCase();
    const hasPhotos = paths.some((value) => value.toLowerCase().startsWith(photosPrefix));
    if (hasPhotos) {
      return prefix;
    }
  }

  return null;
};

const findImageObject = (
  filename: string,
  rootPrefix: string,
  byPath: Map<string, JSZipObject>,
  byBasename: Map<string, JSZipObject[]>
) => {
  const preferredPaths = [
    `${rootPrefix}Photos/post/${filename}`,
    `${rootPrefix}Photos/bereal/${filename}`,
    `${rootPrefix}Photos/${filename}`
  ];

  for (const candidate of preferredPaths) {
    const matched = byPath.get(normalizePath(candidate).toLowerCase());
    if (matched) {
      return matched;
    }
  }

  const matches = byBasename.get(filename.toLowerCase());
  if (!matches || matches.length === 0) {
    return null;
  }

  const postMatch = matches.find((item) =>
    normalizePath(item.name).toLowerCase().includes("/photos/post/")
  );
  if (postMatch) {
    return postMatch;
  }

  const berealMatch = matches.find((item) =>
    normalizePath(item.name).toLowerCase().includes("/photos/bereal/")
  );
  return berealMatch ?? matches[0];
};

const getUniqueFilename = (candidate: string, used: Set<string>) => {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }

  const dotIndex = candidate.lastIndexOf(".");
  const stem = dotIndex === -1 ? candidate : candidate.slice(0, dotIndex);
  const extension = dotIndex === -1 ? "" : candidate.slice(dotIndex);

  let counter = 1;
  while (used.has(`${stem}_${counter}${extension}`)) {
    counter += 1;
  }
  const uniqueName = `${stem}_${counter}${extension}`;
  used.add(uniqueName);
  return uniqueName;
};

const blobToDataUrl = async (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read image data."));
    reader.readAsDataURL(blob);
  });

const dataUrlToBlob = async (dataUrl: string) => {
  const response = await fetch(dataUrl);
  return response.blob();
};

const loadImage = async (blob: Blob) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not decode an image from the export."));
    };
    image.src = objectUrl;
  });

const canvasToBlob = async (
  canvas: HTMLCanvasElement,
  type: "image/jpeg" | "image/png",
  quality?: number
) =>
  new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not encode image output."));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });

const convertToFormatBlob = async (inputBlob: Blob, effectiveFormat: "jpg" | "png") => {
  const image = await loadImage(inputBlob);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a 2D canvas context.");
  }

  context.drawImage(image, 0, 0);

  if (effectiveFormat === "png") {
    return canvasToBlob(canvas, "image/png");
  }

  return canvasToBlob(canvas, "image/jpeg", 0.8);
};

const drawRoundedRectPath = (
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
) => {
  const cappedRadius = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  context.beginPath();
  context.moveTo(x + cappedRadius, y);
  context.lineTo(x + width - cappedRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + cappedRadius);
  context.lineTo(x + width, y + height - cappedRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - cappedRadius, y + height);
  context.lineTo(x + cappedRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - cappedRadius);
  context.lineTo(x, y + cappedRadius);
  context.quadraticCurveTo(x, y, x + cappedRadius, y);
  context.closePath();
};

const combineImages = async (
  baseBlob: Blob,
  overlayBlob: Blob,
  effectiveFormat: "jpg" | "png"
) => {
  const baseImage = await loadImage(baseBlob);
  const overlayImage = await loadImage(overlayBlob);

  const canvas = document.createElement("canvas");
  canvas.width = baseImage.naturalWidth;
  canvas.height = baseImage.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Could not create a 2D canvas context.");
  }

  context.drawImage(baseImage, 0, 0, canvas.width, canvas.height);

  const overlayWidth = Math.max(1, Math.round(overlayImage.naturalWidth * COMBINED_OVERLAY_SCALE));
  const overlayHeight = Math.max(1, Math.round(overlayImage.naturalHeight * COMBINED_OVERLAY_SCALE));

  const x = COMBINED_POSITION.x;
  const y = COMBINED_POSITION.y;

  context.fillStyle = "#000000";
  drawRoundedRectPath(
    context,
    x - COMBINED_OUTLINE_SIZE,
    y - COMBINED_OUTLINE_SIZE,
    overlayWidth + COMBINED_OUTLINE_SIZE * 2,
    overlayHeight + COMBINED_OUTLINE_SIZE * 2,
    COMBINED_CORNER_RADIUS + COMBINED_OUTLINE_SIZE
  );
  context.fill();

  context.save();
  drawRoundedRectPath(context, x, y, overlayWidth, overlayHeight, COMBINED_CORNER_RADIUS);
  context.clip();
  context.drawImage(overlayImage, x, y, overlayWidth, overlayHeight);
  context.restore();

  if (effectiveFormat === "png") {
    return canvasToBlob(canvas, "image/png");
  }

  return canvasToBlob(canvas, "image/jpeg", 0.8);
};

const addExifToJpeg = async (
  blob: Blob,
  takenAt: Date,
  location?: { latitude: number; longitude: number },
  caption?: string
) => {
  const dataUrl = await blobToDataUrl(blob);
  const exifPayload: Record<string, Record<number, unknown> | null> = {
    "0th": {},
    Exif: {},
    GPS: {},
    "1st": {},
    thumbnail: null
  };

  const exifMap = exifPayload.Exif as Record<number, unknown>;
  exifMap[piexif.ExifIFD.DateTimeOriginal] = formatExifDateTimeUtc(takenAt);

  if (caption && caption.trim()) {
    const zerothMap = exifPayload["0th"] as Record<number, unknown>;
    zerothMap[piexif.ImageIFD.ImageDescription] = caption;
  }

  if (location) {
    const gpsMap = exifPayload.GPS as Record<number, unknown>;
    gpsMap[piexif.GPSIFD.GPSLatitudeRef] = location.latitude >= 0 ? "N" : "S";
    gpsMap[piexif.GPSIFD.GPSLatitude] = toExifDegrees(Math.abs(location.latitude));
    gpsMap[piexif.GPSIFD.GPSLongitudeRef] = location.longitude >= 0 ? "E" : "W";
    gpsMap[piexif.GPSIFD.GPSLongitude] = toExifDegrees(Math.abs(location.longitude));
  }

  const exifString = piexif.dump(exifPayload);
  const updatedDataUrl = piexif.insert(exifString, dataUrl);
  return dataUrlToBlob(updatedDataUrl);
};

const parsePosts = (value: unknown): PostPayload[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as PostPayload[];
};

const normalizeLocation = (location?: PostLocation) => {
  if (
    location &&
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude)
  ) {
    return {
      latitude: location.latitude,
      longitude: location.longitude
    };
  }
  return undefined;
};

export async function processBeRealExport(
  inputZipFile: File,
  settings: ProcessorSettings,
  onProgress?: (progress: ProcessorProgress) => void
): Promise<ProcessorResult> {
  const warnings: string[] = [];
  const effectiveFormat: "jpg" | "png" = settings.exportFormat === "png" ? "png" : "jpg";
  const extension = effectiveFormat === "png" ? ".png" : ".jpg";

  if (settings.exportFormat === "heic") {
    warnings.push("HEIC export is not available in browsers yet, so JPG was used.");
  }
  warnings.push("IPTC metadata is skipped in browser mode; JPG exports still include EXIF metadata.");

  const emitProgress = (stage: ProcessorProgress["stage"], current: number, total: number, percent: number) => {
    onProgress?.({
      stage,
      current,
      total,
      percent: Math.max(0, Math.min(100, Math.round(percent)))
    });
  };

  emitProgress("scanning", 0, 0, 0);

  const zip = await JSZip.loadAsync(await inputZipFile.arrayBuffer());
  const rootPrefix = findExportRootPrefix(zip);
  if (!rootPrefix) {
    throw new Error("Could not find posts.json and a Photos folder inside the uploaded zip.");
  }

  const { byPath, byBasename } = buildFileLookup(zip);
  const postsObject = byPath.get(normalizePath(`${rootPrefix}posts.json`).toLowerCase());
  if (!postsObject) {
    throw new Error("Could not read posts.json from the uploaded zip.");
  }

  const postsText = await postsObject.async("string");
  let rawPosts: unknown;
  try {
    rawPosts = JSON.parse(postsText);
  } catch {
    throw new Error("posts.json is not valid JSON.");
  }

  const sinceDate = settings.sinceDate || null;
  const endDate = settings.endDate || null;

  const filteredPosts: ParsedPost[] = [];
  for (const entry of parsePosts(rawPosts)) {
    if (!entry?.takenAt) {
      continue;
    }
    const takenAt = new Date(entry.takenAt);
    if (Number.isNaN(takenAt.getTime())) {
      continue;
    }

    const takenDate = formatDateUtc(takenAt);
    if (sinceDate && takenDate < sinceDate) {
      continue;
    }
    if (endDate && takenDate > endDate) {
      continue;
    }

    filteredPosts.push({ entry, takenAt });
  }

  const processedSingles: OutputFile[] = [];
  const combineCandidates: ProcessedPair[] = [];
  const singleNameSet = new Set<string>();

  emitProgress("processing", 0, filteredPosts.length, filteredPosts.length === 0 ? 50 : 0);

  for (let index = 0; index < filteredPosts.length; index += 1) {
    const parsedPost = filteredPosts[index];
    const timestamp = formatTimestampUtc(parsedPost.takenAt);
    const location = normalizeLocation(parsedPost.entry.location);
    const caption = typeof parsedPost.entry.caption === "string" ? parsedPost.entry.caption : undefined;

    const primaryNameRaw = parsedPost.entry.primary?.path
      ? basename(parsedPost.entry.primary.path)
      : null;
    const secondaryNameRaw = parsedPost.entry.secondary?.path
      ? basename(parsedPost.entry.secondary.path)
      : null;

    if (!primaryNameRaw || !secondaryNameRaw) {
      warnings.push(`Skipped one entry at ${timestamp} because primary/secondary paths were missing.`);
      emitProgress(
        "processing",
        index + 1,
        filteredPosts.length,
        ((index + 1) / Math.max(filteredPosts.length, 1)) * 80
      );
      continue;
    }

    const primaryObject = findImageObject(primaryNameRaw, rootPrefix, byPath, byBasename);
    const secondaryObject = findImageObject(secondaryNameRaw, rootPrefix, byPath, byBasename);

    if (!primaryObject || !secondaryObject) {
      warnings.push(`Skipped one entry at ${timestamp} because an image file was missing in the zip.`);
      emitProgress(
        "processing",
        index + 1,
        filteredPosts.length,
        ((index + 1) / Math.max(filteredPosts.length, 1)) * 80
      );
      continue;
    }

    let primaryFile: OutputFile | null = null;
    let secondaryFile: OutputFile | null = null;

    for (const role of ["primary", "secondary"] as const) {
      try {
        const sourceObject = role === "primary" ? primaryObject : secondaryObject;
        const sourceBlob = await sourceObject.async("blob");
        let outputBlob = await convertToFormatBlob(sourceBlob, effectiveFormat);

        if (effectiveFormat === "jpg") {
          outputBlob = await addExifToJpeg(outputBlob, parsedPost.takenAt, location, caption);
        }

        const uniqueName = getUniqueFilename(`${timestamp}_${role}${extension}`, singleNameSet);
        const outputFile = { name: uniqueName, blob: outputBlob };
        processedSingles.push(outputFile);

        if (role === "primary") {
          primaryFile = outputFile;
        } else {
          secondaryFile = outputFile;
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown processing error.";
        warnings.push(`Failed to process ${role} image for ${timestamp}: ${reason}`);
      }
    }

    if (primaryFile && secondaryFile) {
      combineCandidates.push({
        primary: primaryFile,
        secondary: secondaryFile,
        takenAt: parsedPost.takenAt,
        location,
        caption
      });
    }

    emitProgress(
      "processing",
      index + 1,
      filteredPosts.length,
      ((index + 1) / Math.max(filteredPosts.length, 1)) * 80
    );
  }

  const combinedFiles: OutputFile[] = [];
  if (settings.createCombinedImages) {
    const combinedNameSet = new Set<string>();
    emitProgress("combining", 0, combineCandidates.length, 80);

    for (let index = 0; index < combineCandidates.length; index += 1) {
      const candidate = combineCandidates[index];
      try {
        const baseBlob = settings.rearPhotoLarge ? candidate.primary.blob : candidate.secondary.blob;
        const overlayBlob = settings.rearPhotoLarge
          ? candidate.secondary.blob
          : candidate.primary.blob;

        let combinedBlob = await combineImages(baseBlob, overlayBlob, effectiveFormat);
        if (effectiveFormat === "jpg") {
          combinedBlob = await addExifToJpeg(
            combinedBlob,
            candidate.takenAt,
            candidate.location,
            candidate.caption
          );
        }

        const combinedName = getUniqueFilename(
          `${formatTimestampUtc(candidate.takenAt)}_combined${extension}`,
          combinedNameSet
        );
        combinedFiles.push({
          name: combinedName,
          blob: combinedBlob
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown combine error.";
        warnings.push(
          `Failed to build a combined image for ${formatTimestampUtc(candidate.takenAt)}: ${reason}`
        );
      }

      emitProgress(
        "combining",
        index + 1,
        combineCandidates.length,
        80 + ((index + 1) / Math.max(combineCandidates.length, 1)) * 10
      );
    }
  }

  emitProgress("packaging", 0, 0, 92);

  const exportFiles = settings.createCombinedImages ? combinedFiles : processedSingles;
  const outputZip = new JSZip();
  const exportDate = new Date().toISOString().slice(0, 10);
  const exportBaseName = `${exportDate}_BeReal–Processing_Export`;
  const rootFolder = outputZip.folder(exportBaseName);
  if (!rootFolder) {
    throw new Error("Could not prepare output archive.");
  }

  for (const file of exportFiles) {
    rootFolder.file(file.name, file.blob);
  }

  const outputBlob = await outputZip.generateAsync(
    {
      type: "blob",
      compression: "DEFLATE"
    },
    (metadata) => {
      emitProgress("packaging", 0, 0, 92 + metadata.percent * 0.07);
    }
  );

  emitProgress("complete", 1, 1, 100);

  const dedupedWarnings = Array.from(new Set(warnings));
  return {
    blob: outputBlob,
    filename: `${exportBaseName}.zip`,
    exportedCount: exportFiles.length,
    warnings: dedupedWarnings,
    effectiveFormat
  };
}
