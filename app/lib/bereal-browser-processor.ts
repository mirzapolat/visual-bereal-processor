import JSZip, { type JSZipObject } from "jszip";
import piexif from "piexifjs";
import tzLookup from "tz-lookup";

export type ProcessorSettings = {
  exportFormat: "jpg" | "png";
  createCombinedImages: boolean;
  rearPhotoLarge: boolean;
  sinceDate: string;
  endDate: string;
  fallbackTimezone: string;
  timezoneOverrides: TimezoneOverrideSpan[];
};

export type TimezoneOverrideSpan = {
  startDate: string;
  endDate: string;
  timeZone: string;
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
  shareFiles: ProcessedExportFile[];
};

export type ExportDateBounds = {
  earliestDate: string;
  latestDate: string;
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

export type ProcessedExportFile = {
  name: string;
  blob: Blob;
};

type ProcessedPair = {
  primary: ProcessedExportFile;
  secondary: ProcessedExportFile;
  takenAt: Date;
  timeZone: string;
  location?: { latitude: number; longitude: number };
  caption?: string;
};

type JpegMetadataResult = {
  blob: Blob;
  iptcEmbedded: boolean;
};

type ResolvedDateTime = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
};

const COMBINED_OVERLAY_SCALE = 1 / 3.33333333;
const COMBINED_CORNER_RADIUS = 60;
const COMBINED_OUTLINE_SIZE = 7;
const COMBINED_POSITION = { x: 55, y: 55 };
const textEncoder = new TextEncoder();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

const normalizePath = (value: string) =>
  value
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");

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

const formatIptcDateUtc = (date: Date) =>
  `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;

const formatIptcTimeUtc = (date: Date) =>
  `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}+0000`;

const formatDateInTimeZone = (date: Date, timeZone: string) => {
  const resolved = resolveDateTimeInTimeZone(date, timeZone);
  return `${resolved.year}-${pad(resolved.month)}-${pad(resolved.day)}`;
};

const getTimeZoneFormatter = (timeZone: string) => {
  const cached = dateTimeFormatterCache.get(timeZone);
  if (cached) {
    return cached;
  }

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "iso8601",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  dateTimeFormatterCache.set(timeZone, formatter);
  return formatter;
};

const readDateTimePart = (parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes) => {
  const value = parts.find((part) => part.type === type)?.value;
  if (!value) {
    throw new Error(`Could not read ${type} from formatted date.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Could not parse ${type} from formatted date.`);
  }
  return parsed;
};

const resolveDateTimeInTimeZone = (date: Date, timeZone: string): ResolvedDateTime => {
  const formatter = getTimeZoneFormatter(timeZone);
  const parts = formatter.formatToParts(date);

  const year = readDateTimePart(parts, "year");
  const month = readDateTimePart(parts, "month");
  const day = readDateTimePart(parts, "day");
  const rawHour = readDateTimePart(parts, "hour");
  const hour = rawHour === 24 ? 0 : rawHour;
  const minute = readDateTimePart(parts, "minute");
  const second = readDateTimePart(parts, "second");

  const projectedUtcTimestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const offsetMinutes = Math.round((projectedUtcTimestamp - date.getTime()) / 60000);

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offsetMinutes
  };
};

const formatTimestampInTimeZone = (date: Date, timeZone: string) => {
  const resolved = resolveDateTimeInTimeZone(date, timeZone);
  return `${resolved.year}-${pad(resolved.month)}-${pad(resolved.day)}T${pad(resolved.hour)}-${pad(
    resolved.minute
  )}-${pad(resolved.second)}`;
};

const formatExifDateTimeInTimeZone = (date: Date, timeZone: string) => {
  const resolved = resolveDateTimeInTimeZone(date, timeZone);
  return `${resolved.year}:${pad(resolved.month)}:${pad(resolved.day)} ${pad(resolved.hour)}:${pad(
    resolved.minute
  )}:${pad(resolved.second)}`;
};

const formatIptcDateInTimeZone = (date: Date, timeZone: string) => {
  const resolved = resolveDateTimeInTimeZone(date, timeZone);
  return `${resolved.year}${pad(resolved.month)}${pad(resolved.day)}`;
};

const formatUtcOffset = (offsetMinutes: number) => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}${pad(minutes)}`;
};

const formatExifUtcOffset = (offsetMinutes: number) => {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;
  return `${sign}${pad(hours)}:${pad(minutes)}`;
};

const formatIptcTimeInTimeZone = (date: Date, timeZone: string) => {
  const resolved = resolveDateTimeInTimeZone(date, timeZone);
  return `${pad(resolved.hour)}${pad(resolved.minute)}${pad(resolved.second)}${formatUtcOffset(
    resolved.offsetMinutes
  )}`;
};

const formatExifOffsetInTimeZone = (date: Date, timeZone: string) =>
  formatExifUtcOffset(resolveDateTimeInTimeZone(date, timeZone).offsetMinutes);

const validateTimeZone = (value: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
};

const EXIF_OFFSET_TIME_TAG = 36880;
const EXIF_OFFSET_TIME_ORIGINAL_TAG = 36881;
const EXIF_OFFSET_TIME_DIGITIZED_TAG = 36882;

const ensureExifOffsetTagsRegistered = () => {
  const piexifWithTags = piexif as typeof piexif & {
    TAGS?: {
      Exif?: Record<number, { name: string; type: string }>;
    };
  };

  const exifTags = piexifWithTags.TAGS?.Exif;
  if (!exifTags) {
    return false;
  }

  if (!exifTags[EXIF_OFFSET_TIME_TAG]) {
    exifTags[EXIF_OFFSET_TIME_TAG] = { name: "OffsetTime", type: "Ascii" };
  }
  if (!exifTags[EXIF_OFFSET_TIME_ORIGINAL_TAG]) {
    exifTags[EXIF_OFFSET_TIME_ORIGINAL_TAG] = { name: "OffsetTimeOriginal", type: "Ascii" };
  }
  if (!exifTags[EXIF_OFFSET_TIME_DIGITIZED_TAG]) {
    exifTags[EXIF_OFFSET_TIME_DIGITIZED_TAG] = { name: "OffsetTimeDigitized", type: "Ascii" };
  }

  return true;
};

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
  const entries = Object.values(zip.files).map((zipObject) => ({
    path: normalizePath(zipObject.name),
    dir: zipObject.dir
  }));
  const allPaths = entries.map((entry) => entry.path);
  const postsCandidates = entries
    .filter((entry) => !entry.dir && entry.path.toLowerCase().endsWith("posts.json"))
    .map((entry) => entry.path);

  for (const candidate of postsCandidates) {
    const prefix = candidate.slice(0, candidate.length - "posts.json".length);
    const photosPrefix = `${prefix}Photos/`.toLowerCase();
    const hasPhotos = allPaths.some((value) => value.toLowerCase().startsWith(photosPrefix));
    if (hasPhotos) {
      return prefix;
    }
  }

  const hasPhotosSomewhere = allPaths.some((value) => /(^|\/)photos\//i.test(value));
  if (!hasPhotosSomewhere || postsCandidates.length === 0) {
    return null;
  }

  // Fallback for exports where posts.json and Photos are packaged under different wrapper prefixes.
  const bestCandidate = [...postsCandidates].sort((left, right) => left.length - right.length)[0];
  return bestCandidate.slice(0, bestCandidate.length - "posts.json".length);

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

const concatByteArrays = (parts: Uint8Array[]) => {
  const totalSize = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
};

const buildIptcDataset = (dataset: number, value: Uint8Array) => {
  if (dataset < 0 || dataset > 255) {
    throw new Error("IPTC dataset id must fit in one byte.");
  }
  if (value.length > 0xffff) {
    throw new Error("IPTC dataset value is too large.");
  }
  const header = new Uint8Array(5);
  header[0] = 0x1c;
  header[1] = 0x02;
  header[2] = dataset;
  header[3] = (value.length >> 8) & 0xff;
  header[4] = value.length & 0xff;
  return concatByteArrays([header, value]);
};

const buildIptcPayload = (takenAt: Date, timeZone: string, caption?: string) => {
  const datasets: Uint8Array[] = [];
  // IPTC CodedCharacterSet = UTF-8 marker.
  datasets.push(buildIptcDataset(90, new Uint8Array([0x1b, 0x25, 0x47])));
  datasets.push(buildIptcDataset(55, textEncoder.encode(formatIptcDateInTimeZone(takenAt, timeZone))));
  datasets.push(buildIptcDataset(60, textEncoder.encode(formatIptcTimeInTimeZone(takenAt, timeZone))));

  const trimmedCaption = caption?.trim();
  if (trimmedCaption) {
    datasets.push(buildIptcDataset(120, textEncoder.encode(trimmedCaption)));
  }

  return concatByteArrays(datasets);
};

const buildIptcApp13Segment = (iptcPayload: Uint8Array) => {
  const photoshopHeader = textEncoder.encode("Photoshop 3.0\u0000");
  const resourceSignature = textEncoder.encode("8BIM");
  const resourceId = new Uint8Array([0x04, 0x04]);
  // Empty Pascal resource name plus required even-byte padding.
  const resourceName = new Uint8Array([0x00, 0x00]);
  const resourceSize = iptcPayload.length;
  const resourceSizeBytes = new Uint8Array([
    (resourceSize >>> 24) & 0xff,
    (resourceSize >>> 16) & 0xff,
    (resourceSize >>> 8) & 0xff,
    resourceSize & 0xff
  ]);
  const payloadPadding = resourceSize % 2 === 0 ? new Uint8Array(0) : new Uint8Array([0x00]);
  const app13Payload = concatByteArrays([
    photoshopHeader,
    resourceSignature,
    resourceId,
    resourceName,
    resourceSizeBytes,
    iptcPayload,
    payloadPadding
  ]);

  const segmentLength = app13Payload.length + 2;
  if (segmentLength > 0xffff) {
    throw new Error("IPTC metadata is too large for a JPEG APP13 segment.");
  }

  const segment = new Uint8Array(4 + app13Payload.length);
  segment[0] = 0xff;
  segment[1] = 0xed;
  segment[2] = (segmentLength >> 8) & 0xff;
  segment[3] = segmentLength & 0xff;
  segment.set(app13Payload, 4);
  return segment;
};

const findJpegMetadataInsertOffset = (jpegData: Uint8Array) => {
  if (jpegData.length < 4 || jpegData[0] !== 0xff || jpegData[1] !== 0xd8) {
    throw new Error("Invalid JPEG stream.");
  }

  let offset = 2;
  while (offset + 1 < jpegData.length) {
    if (jpegData[offset] !== 0xff) {
      throw new Error("Malformed JPEG marker sequence.");
    }

    let markerOffset = offset;
    while (markerOffset + 1 < jpegData.length && jpegData[markerOffset + 1] === 0xff) {
      markerOffset += 1;
    }
    if (markerOffset + 1 >= jpegData.length) {
      break;
    }

    const marker = jpegData[markerOffset + 1];
    if (marker === 0xda || marker === 0xd9) {
      return markerOffset;
    }

    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = markerOffset + 2;
      continue;
    }

    if (markerOffset + 3 >= jpegData.length) {
      throw new Error("Truncated JPEG segment.");
    }
    const segmentLength = (jpegData[markerOffset + 2] << 8) | jpegData[markerOffset + 3];
    if (segmentLength < 2) {
      throw new Error("Invalid JPEG segment length.");
    }
    const nextOffset = markerOffset + 2 + segmentLength;
    if (nextOffset > jpegData.length) {
      throw new Error("JPEG segment length exceeds file size.");
    }
    offset = nextOffset;
  }

  throw new Error("Could not determine JPEG metadata insertion point.");
};

const addIptcToJpeg = async (blob: Blob, takenAt: Date, timeZone: string, caption?: string) => {
  const jpegData = new Uint8Array(await blob.arrayBuffer());
  const iptcPayload = buildIptcPayload(takenAt, timeZone, caption);
  const app13Segment = buildIptcApp13Segment(iptcPayload);
  const insertOffset = findJpegMetadataInsertOffset(jpegData);

  const merged = concatByteArrays([
    jpegData.slice(0, insertOffset),
    app13Segment,
    jpegData.slice(insertOffset)
  ]);
  return new Blob([merged], { type: "image/jpeg" });
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

const addMetadataToJpeg = async (
  blob: Blob,
  takenAt: Date,
  timeZone: string,
  location?: { latitude: number; longitude: number },
  caption?: string
): Promise<JpegMetadataResult> => {
  const dataUrl = await blobToDataUrl(blob);
  const exifPayload: Record<string, Record<number, unknown> | null> = {
    "0th": {},
    Exif: {},
    GPS: {},
    "1st": {},
    thumbnail: null
  };

  const exifMap = exifPayload.Exif as Record<number, unknown>;
  const exifLocalDateTime = formatExifDateTimeInTimeZone(takenAt, timeZone);
  exifMap[piexif.ExifIFD.DateTimeOriginal] = exifLocalDateTime;
  exifMap[piexif.ExifIFD.DateTimeDigitized] = exifLocalDateTime;
  if (ensureExifOffsetTagsRegistered()) {
    const exifOffset = formatExifOffsetInTimeZone(takenAt, timeZone);
    exifMap[EXIF_OFFSET_TIME_TAG] = exifOffset;
    exifMap[EXIF_OFFSET_TIME_ORIGINAL_TAG] = exifOffset;
    exifMap[EXIF_OFFSET_TIME_DIGITIZED_TAG] = exifOffset;
  }

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
  const exifBlob = await dataUrlToBlob(updatedDataUrl);

  try {
    const metadataBlob = await addIptcToJpeg(exifBlob, takenAt, timeZone, caption);
    return {
      blob: metadataBlob,
      iptcEmbedded: true
    };
  } catch {
    return {
      blob: exifBlob,
      iptcEmbedded: false
    };
  }
};

const parsePosts = (value: unknown): PostPayload[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value as PostPayload[];
};

export async function extractExportDateBounds(inputZipFile: File): Promise<ExportDateBounds | null> {
  const zip = await JSZip.loadAsync(await inputZipFile.arrayBuffer());
  const rootPrefix = findExportRootPrefix(zip);
  if (rootPrefix === null) {
    return null;
  }

  const { byPath } = buildFileLookup(zip);
  const postsObject = byPath.get(normalizePath(`${rootPrefix}posts.json`).toLowerCase());
  if (!postsObject) {
    return null;
  }

  let rawPosts: unknown;
  try {
    rawPosts = JSON.parse(await postsObject.async("string"));
  } catch {
    return null;
  }

  let earliestTimestamp = Number.POSITIVE_INFINITY;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const entry of parsePosts(rawPosts)) {
    if (!entry?.takenAt) {
      continue;
    }
    const takenAt = new Date(entry.takenAt);
    const timestamp = takenAt.getTime();
    if (Number.isNaN(timestamp)) {
      continue;
    }
    if (timestamp < earliestTimestamp) {
      earliestTimestamp = timestamp;
    }
    if (timestamp > latestTimestamp) {
      latestTimestamp = timestamp;
    }
  }

  if (!Number.isFinite(earliestTimestamp) || !Number.isFinite(latestTimestamp)) {
    return null;
  }

  return {
    earliestDate: formatDateUtc(new Date(earliestTimestamp)),
    latestDate: formatDateUtc(new Date(latestTimestamp))
  };
}

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

const normalizeFallbackTimezone = (fallbackTimezone: string) => {
  const trimmed = fallbackTimezone.trim();
  if (!trimmed) {
    return null;
  }
  if (!validateTimeZone(trimmed)) {
    throw new Error(
      `Fallback timezone "${trimmed}" is not valid. Please use an IANA timezone like Europe/Berlin or America/New_York.`
    );
  }
  return trimmed;
};

type NormalizedTimezoneOverrideSpan = {
  startDate: string | null;
  endDate: string | null;
  timeZone: string;
};

const isIsoDateString = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value);

const normalizeTimezoneOverrides = (overrides: TimezoneOverrideSpan[]) => {
  const normalized: NormalizedTimezoneOverrideSpan[] = [];

  for (let index = 0; index < overrides.length; index += 1) {
    const override = overrides[index];
    const startDate = override.startDate.trim();
    const endDate = override.endDate.trim();
    const timeZone = override.timeZone.trim();
    const rowLabel = `Timezone span ${index + 1}`;

    if (!startDate && !endDate && !timeZone) {
      continue;
    }

    if (!timeZone) {
      throw new Error(`${rowLabel} is missing a timezone.`);
    }
    if (!validateTimeZone(timeZone)) {
      throw new Error(
        `${rowLabel} has an invalid timezone "${timeZone}". Please choose a valid IANA timezone.`
      );
    }

    if (startDate && !isIsoDateString(startDate)) {
      throw new Error(`${rowLabel} start date is invalid.`);
    }
    if (endDate && !isIsoDateString(endDate)) {
      throw new Error(`${rowLabel} end date is invalid.`);
    }
    if (startDate && endDate && startDate > endDate) {
      throw new Error(`${rowLabel} start date must be before or equal to the end date.`);
    }

    normalized.push({
      startDate: startDate || null,
      endDate: endDate || null,
      timeZone
    });
  }

  return normalized;
};

const findTimezoneFromOverrides = (
  takenAt: Date,
  overrides: NormalizedTimezoneOverrideSpan[]
) => {
  let matchedTimeZone: string | null = null;

  for (const override of overrides) {
    const localDateInOverrideZone = formatDateInTimeZone(takenAt, override.timeZone);
    if (override.startDate && localDateInOverrideZone < override.startDate) {
      continue;
    }
    if (override.endDate && localDateInOverrideZone > override.endDate) {
      continue;
    }
    // If ranges overlap, later rows override earlier rows.
    matchedTimeZone = override.timeZone;
  }

  return matchedTimeZone;
};

const resolvePostTimezone = (
  takenAt: Date,
  location: { latitude: number; longitude: number } | undefined,
  timezoneOverrides: NormalizedTimezoneOverrideSpan[],
  fallbackTimezone: string | null,
  warnings: string[]
) => {
  if (!location) {
    const overrideTimezone = findTimezoneFromOverrides(takenAt, timezoneOverrides);
    if (overrideTimezone) {
      return overrideTimezone;
    }
    if (!fallbackTimezone) {
      throw new Error(
        "A photo does not include location data and did not match any custom timezone timespan. Please add a matching timespan via Set Timezones or choose a fallback timezone in Step 2."
      );
    }
    return fallbackTimezone;
  }

  try {
    const timeZone = tzLookup(location.latitude, location.longitude);
    if (!validateTimeZone(timeZone)) {
      throw new Error(`Unsupported timezone "${timeZone}" returned by location lookup.`);
    }
    return timeZone;
  } catch (error) {
    if (fallbackTimezone) {
      warnings.push(
        `Used fallback timezone ${fallbackTimezone} for one photo at ${formatTimestampUtc(
          takenAt
        )} because timezone lookup from coordinates failed.`
      );
      return fallbackTimezone;
    }

    const reason = error instanceof Error ? error.message : "Unknown timezone lookup error.";
    throw new Error(
      `Could not determine a timezone from photo coordinates (${location.latitude}, ${location.longitude}) and no fallback timezone is set. ${reason}`
    );
  }
};

export async function processBeRealExport(
  inputZipFile: File,
  settings: ProcessorSettings,
  onProgress?: (progress: ProcessorProgress) => void
): Promise<ProcessorResult> {
  const warnings: string[] = [];
  let iptcEmbeddingFailed = false;
  const effectiveFormat: "jpg" | "png" = settings.exportFormat;
  const extension = effectiveFormat === "png" ? ".png" : ".jpg";

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
  if (rootPrefix === null) {
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

  const fallbackTimezone = normalizeFallbackTimezone(settings.fallbackTimezone);
  const timezoneOverrides = normalizeTimezoneOverrides(settings.timezoneOverrides ?? []);

  const processedSingles: ProcessedExportFile[] = [];
  const combineCandidates: ProcessedPair[] = [];
  const singleNameSet = new Set<string>();

  emitProgress("processing", 0, filteredPosts.length, filteredPosts.length === 0 ? 50 : 0);

  for (let index = 0; index < filteredPosts.length; index += 1) {
    const parsedPost = filteredPosts[index];
    const location = normalizeLocation(parsedPost.entry.location);
    const caption = typeof parsedPost.entry.caption === "string" ? parsedPost.entry.caption : undefined;
    const resolvedTimeZone = resolvePostTimezone(
      parsedPost.takenAt,
      location,
      timezoneOverrides,
      fallbackTimezone,
      warnings
    );
    const timestamp = formatTimestampInTimeZone(parsedPost.takenAt, resolvedTimeZone);

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

    let primaryFile: ProcessedExportFile | null = null;
    let secondaryFile: ProcessedExportFile | null = null;

    for (const role of ["primary", "secondary"] as const) {
      try {
        const sourceObject = role === "primary" ? primaryObject : secondaryObject;
        const sourceBlob = await sourceObject.async("blob");
        let outputBlob = await convertToFormatBlob(sourceBlob, effectiveFormat);

        if (effectiveFormat === "jpg") {
          const metadataResult = await addMetadataToJpeg(
            outputBlob,
            parsedPost.takenAt,
            resolvedTimeZone,
            location,
            caption
          );
          outputBlob = metadataResult.blob;
          if (!metadataResult.iptcEmbedded) {
            iptcEmbeddingFailed = true;
          }
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
        warnings.push(`Failed to process ${role} image for ${timestamp} (${resolvedTimeZone}): ${reason}`);
      }
    }

    if (primaryFile && secondaryFile) {
      combineCandidates.push({
        primary: primaryFile,
        secondary: secondaryFile,
        takenAt: parsedPost.takenAt,
        timeZone: resolvedTimeZone,
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

  const combinedFiles: ProcessedExportFile[] = [];
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
          const metadataResult = await addMetadataToJpeg(
            combinedBlob,
            candidate.takenAt,
            candidate.timeZone,
            candidate.location,
            candidate.caption
          );
          combinedBlob = metadataResult.blob;
          if (!metadataResult.iptcEmbedded) {
            iptcEmbeddingFailed = true;
          }
        }

        const combinedName = getUniqueFilename(
          `${formatTimestampInTimeZone(candidate.takenAt, candidate.timeZone)}_combined${extension}`,
          combinedNameSet
        );
        combinedFiles.push({
          name: combinedName,
          blob: combinedBlob
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "Unknown combine error.";
        warnings.push(
          `Failed to build a combined image for ${formatTimestampInTimeZone(candidate.takenAt, candidate.timeZone)} (${candidate.timeZone}): ${reason}`
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

  if (effectiveFormat === "jpg" && iptcEmbeddingFailed) {
    warnings.push("Could not embed IPTC metadata for one or more JPG exports; EXIF metadata was still written.");
  }

  const dedupedWarnings = Array.from(new Set(warnings));
  return {
    blob: outputBlob,
    filename: `${exportBaseName}.zip`,
    exportedCount: exportFiles.length,
    warnings: dedupedWarnings,
    effectiveFormat,
    shareFiles: [...exportFiles]
  };
}
