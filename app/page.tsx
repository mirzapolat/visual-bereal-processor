"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  extractExportDateBounds,
  processBeRealExport,
  type ExportDateBounds,
  type ProcessorProgress,
  type ProcessorSettings
} from "./lib/bereal-browser-processor";

type SettingsState = ProcessorSettings;

type ToggleKey = "createCombinedImages" | "rearPhotoLarge";
const DEFAULT_SHARE_BUTTON_TEXT = "Like this website? Share it with a friend!";

const accentPalette = [
  { accent: "#1f4fd6", soft: "#e7eefb" },
  { accent: "#0f9d58", soft: "#e6f6ee" },
  { accent: "#f97316", soft: "#fff2e6" },
  { accent: "#ec4899", soft: "#fde7f3" },
  { accent: "#8b5cf6", soft: "#efe9ff" },
  { accent: "#06b6d4", soft: "#e6f9fb" },
  { accent: "#ef4444", soft: "#ffe7e7" },
  { accent: "#a85520", soft: "#f4e6dc" }
];

const hexToRgb = (hex: string) => {
  const normalized = hex.replace("#", "");
  const value =
    normalized.length === 3
      ? normalized
          .split("")
          .map((char) => char + char)
          .join("")
      : normalized;
  const intValue = Number.parseInt(value, 16);
  return {
    r: (intValue >> 16) & 255,
    g: (intValue >> 8) & 255,
    b: intValue & 255
  };
};

const initialSettings: SettingsState = {
  exportFormat: "jpg",
  createCombinedImages: true,
  rearPhotoLarge: true,
  sinceDate: "",
  endDate: "",
  fallbackTimezone: "",
  timezoneOverrides: []
};

const initialProgress: ProcessorProgress = {
  stage: "scanning",
  current: 0,
  total: 0,
  percent: 0
};

const getSupportedTimeZones = () => {
  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: "timeZone") => string[];
  };

  const supportedValuesOf = intlWithSupportedValues.supportedValuesOf;
  if (!supportedValuesOf) {
    return ["UTC"];
  }

  try {
    const zones = supportedValuesOf("timeZone");
    const deduped = new Set<string>(["UTC", ...zones]);
    return [...deduped].sort((left, right) => {
      if (left === right) return 0;
      if (left === "UTC") return -1;
      if (right === "UTC") return 1;
      return left.localeCompare(right);
    });
  } catch {
    return ["UTC"];
  }
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [uploadAnimationTick, setUploadAnimationTick] = useState(0);
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [downloadBlob, setDownloadBlob] = useState<Blob | null>(null);
  const [downloadName, setDownloadName] = useState<string | null>(null);
  const [galleryShareFiles, setGalleryShareFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showExportHelp, setShowExportHelp] = useState(false);
  const [showTimezoneOverrides, setShowTimezoneOverrides] = useState(false);
  const [exportedCount, setExportedCount] = useState<number | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<ProcessorProgress>(initialProgress);
  const [dateBounds, setDateBounds] = useState<ExportDateBounds | null>(null);
  const [isDetectingDateBounds, setIsDetectingDateBounds] = useState(false);
  const [shareButtonText, setShareButtonText] = useState(DEFAULT_SHARE_BUTTON_TEXT);
  const dateBoundsRequestIdRef = useRef(0);
  const shareButtonResetTimerRef = useRef<number | null>(null);
  const fallbackTimezoneOptions = useMemo(() => {
    const zones = getSupportedTimeZones();
    if (!settings.fallbackTimezone || zones.includes(settings.fallbackTimezone)) {
      return zones;
    }

    return [settings.fallbackTimezone, ...zones].sort((left, right) => {
      if (left === right) return 0;
      if (left === settings.fallbackTimezone) return -1;
      if (right === settings.fallbackTimezone) return 1;
      if (left === "UTC") return -1;
      if (right === "UTC") return 1;
      return left.localeCompare(right);
    });
  }, [settings.fallbackTimezone]);

  const addTimezoneOverride = useCallback(() => {
    setSettings((previous) => ({
      ...previous,
      timezoneOverrides: [
        ...previous.timezoneOverrides,
        {
          startDate: "",
          endDate: "",
          timeZone: ""
        }
      ]
    }));
  }, []);

  const updateTimezoneOverride = useCallback(
    (index: number, patch: Partial<SettingsState["timezoneOverrides"][number]>) => {
      setSettings((previous) => ({
        ...previous,
        timezoneOverrides: previous.timezoneOverrides.map((override, overrideIndex) =>
          overrideIndex === index ? { ...override, ...patch } : override
        )
      }));
    },
    []
  );

  const removeTimezoneOverride = useCallback((index: number) => {
    setSettings((previous) => ({
      ...previous,
      timezoneOverrides: previous.timezoneOverrides.filter((_, overrideIndex) => overrideIndex !== index)
    }));
  }, []);

  useEffect(() => {
    const { body } = document;
    const animationFrame = window.requestAnimationFrame(() => {
      body.style.transition = "opacity 320ms cubic-bezier(0.22, 1, 0.36, 1)";
      body.style.opacity = "1";
      body.dataset.appReady = "true";
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
    };
  }, []);

  useEffect(() => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!browserTimezone) {
      return;
    }
    setSettings((previous) =>
      previous.fallbackTimezone
        ? previous
        : {
            ...previous,
            fallbackTimezone: browserTimezone
          }
    );
  }, []);

  const inputsDisabled = isProcessing;
  const dateInputsDisabled = isProcessing || isDetectingDateBounds;

  const clearDownloadData = useCallback(() => {
    setDownloadUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
    setDownloadBlob(null);
    setDownloadName(null);
    setGalleryShareFiles([]);
  }, []);

  useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
      if (shareButtonResetTimerRef.current !== null) {
        window.clearTimeout(shareButtonResetTimerRef.current);
      }
    };
  }, [downloadUrl]);

  const showLinkCopiedOnButton = useCallback(() => {
    setShareButtonText("Link copied!");
    if (shareButtonResetTimerRef.current !== null) {
      window.clearTimeout(shareButtonResetTimerRef.current);
    }
    shareButtonResetTimerRef.current = window.setTimeout(() => {
      setShareButtonText(DEFAULT_SHARE_BUTTON_TEXT);
      shareButtonResetTimerRef.current = null;
    }, 2200);
  }, []);

  const toggle = (key: ToggleKey) => {
    if (inputsDisabled) return;
    setSettings((previous) => ({ ...previous, [key]: !previous[key] }));
  };

  const handleToggleKey =
    (key: ToggleKey) => (event: React.KeyboardEvent<HTMLLabelElement>) => {
      if (inputsDisabled) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(key);
      }
    };

  const handleFile = useCallback(
    async (newFile: File | null) => {
      const requestId = dateBoundsRequestIdRef.current + 1;
      dateBoundsRequestIdRef.current = requestId;

      setFile(newFile);
      if (newFile) {
        setUploadAnimationTick((previous) => previous + 1);
      }
      setError(null);
      setStatus(null);
      setWarnings([]);
      clearDownloadData();
      setExportedCount(null);
      setProgress(initialProgress);
      setIsProcessing(false);
      setDateBounds(null);
      setIsDetectingDateBounds(false);

      if (!newFile) {
        setSettings((previous) => ({
          ...previous,
          sinceDate: "",
          endDate: ""
        }));
        return;
      }

      setIsDetectingDateBounds(true);
      try {
        const nextBounds = await extractExportDateBounds(newFile);
        if (dateBoundsRequestIdRef.current !== requestId) {
          return;
        }

        if (!nextBounds) {
          setSettings((previous) => ({
            ...previous,
            sinceDate: "",
            endDate: ""
          }));
          return;
        }

        setDateBounds(nextBounds);
        setSettings((previous) => ({
          ...previous,
          sinceDate: nextBounds.earliestDate,
          endDate: nextBounds.latestDate
        }));
      } catch {
        if (dateBoundsRequestIdRef.current !== requestId) {
          return;
        }
        setSettings((previous) => ({
          ...previous,
          sinceDate: "",
          endDate: ""
        }));
      } finally {
        if (dateBoundsRequestIdRef.current === requestId) {
          setIsDetectingDateBounds(false);
        }
      }
    },
    [clearDownloadData]
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      if (inputsDisabled) return;
      setDragging(false);
      const droppedFile = event.dataTransfer.files?.[0];
      if (droppedFile) {
        void handleFile(droppedFile);
      }
    },
    [handleFile, inputsDisabled]
  );

  const onBrowse = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (inputsDisabled) return;
      const newFile = event.target.files?.[0] ?? null;
      void handleFile(newFile);
    },
    [handleFile, inputsDisabled]
  );

  const formattedSize = useMemo(() => {
    if (!file) return "";
    const mb = file.size / 1024 / 1024;
    return `${mb.toFixed(2)} MB`;
  }, [file]);

  const progressLabel = useMemo(() => {
    const stageMap: Record<ProcessorProgress["stage"], string> = {
      scanning: "Scanning export",
      processing: "Processing entries",
      combining: "Combining images",
      packaging: "Packaging zip",
      complete: "Finalizing"
    };
    const label = stageMap[progress.stage] ?? "Processing";
    if (progress.total > 0 && progress.stage !== "complete") {
      return `${label} (${progress.current}/${progress.total})`;
    }
    return label;
  }, [progress]);

  useEffect(() => {
    const choice = accentPalette[Math.floor(Math.random() * accentPalette.length)];
    const { r, g, b } = hexToRgb(choice.accent);
    const root = document.documentElement;
    root.style.setProperty("--accent", choice.accent);
    root.style.setProperty("--accent-soft", choice.soft);
    root.style.setProperty("--focus", `0 0 0 3px rgba(${r}, ${g}, ${b}, 0.16)`);
  }, []);

  const handleShareSite = useCallback(async () => {
    const isLikelyMobile =
      /Android|iPhone|iPod|Mobile|Windows Phone|Opera Mini|IEMobile/i.test(navigator.userAgent) ||
      ((/iPad|Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ?? false);

    if (!isLikelyMobile) {
      try {
        if (navigator.clipboard) {
          await navigator.clipboard.writeText(window.location.href);
          showLinkCopiedOnButton();
          setStatus("Link copied to clipboard.");
        } else {
          setStatus("Copy the page URL to share with friends.");
        }
      } catch {
        setStatus("Copy the page URL to share with friends.");
      }
      return;
    }

    const shareData = {
      title: "BeReal Processor",
      text: "Export your BeReal memories in a photo-friendly format.",
      url: window.location.href
    };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch {
        // Ignore cancellation.
      }
    }

    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
        showLinkCopiedOnButton();
        setStatus("Link copied to clipboard.");
      } else {
        setStatus("Copy the page URL to share with friends.");
      }
    } catch {
      setStatus("Copy the page URL to share with friends.");
    }
  }, [showLinkCopiedOnButton]);

  const handleExportToGallery = useCallback(async () => {
    if (galleryShareFiles.length === 0) {
      setStatus("No exported photos are ready to share yet.");
      return;
    }
    if (!navigator.share) {
      setStatus("Sharing files is not supported on this device.");
      return;
    }

    setStatus("Preparing files for sharing…");
    try {
      if (navigator.canShare && !navigator.canShare({ files: galleryShareFiles })) {
        setStatus("Sharing files is not supported on this device.");
        return;
      }
      await navigator.share({
        title: "BeReal memories",
        files: galleryShareFiles
      });
      setStatus("Share sheet opened.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to share files.";
      setError(message);
      setStatus(null);
    }
  }, [galleryShareFiles]);

  const handleSubmit = useCallback(async () => {
    if (!file) {
      setError("Please upload your BeReal export zip file first.");
      return;
    }

    setIsProcessing(true);
    setStatus(null);
    setError(null);
    setWarnings([]);
    setExportedCount(null);
    clearDownloadData();
    setProgress({
      stage: "scanning",
      current: 0,
      total: 0,
      percent: 1
    });

    try {
      const result = await processBeRealExport(file, settings, (nextProgress) => {
        setProgress(nextProgress);
      });

      const objectUrl = URL.createObjectURL(result.blob);
      const shareFiles = result.shareFiles.map(
        (exportFile) =>
          new File([exportFile.blob], exportFile.name, {
            type: exportFile.blob.type || (result.effectiveFormat === "png" ? "image/png" : "image/jpeg")
          })
      );
      setDownloadUrl(objectUrl);
      setDownloadBlob(result.blob);
      setDownloadName(result.filename);
      setGalleryShareFiles(shareFiles);
      setExportedCount(result.exportedCount);
      setWarnings(result.warnings);
      setStatus(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Local processing failed.";
      setError(message);
      setStatus(null);
      setDownloadBlob(null);
      setDownloadName(null);
      setGalleryShareFiles([]);
      setWarnings([]);
      setExportedCount(null);
    } finally {
      setIsProcessing(false);
    }
  }, [clearDownloadData, file, settings]);

  return (
    <main className="page-shell">
      <header className="topbar stage-fade stage-fade-delay-1">
        <div className="brand-lockup">
          <h1 className="logo">
            BeReal Gallery <span>Backup</span>
          </h1>
          <p className="tagline">
            Process your BeReal export so you can back them up in your phone&apos;s gallery.
          </p>
        </div>
        <a
          className="github-button"
          href="https://github.com/mirzapolat/visual-bereal-processor"
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
            <path d="M12 .5C5.65.5.5 5.78.5 12.3c0 5.22 3.44 9.65 8.2 11.21.6.12.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.75-4.04-1.65-4.04-1.65-.55-1.42-1.34-1.8-1.34-1.8-1.1-.78.08-.77.08-.77 1.22.09 1.86 1.27 1.86 1.27 1.08 1.92 2.84 1.37 3.53 1.05.11-.8.42-1.37.76-1.68-2.66-.31-5.46-1.35-5.46-6.03 0-1.34.46-2.43 1.24-3.29-.12-.31-.54-1.58.12-3.28 0 0 1.01-.33 3.3 1.26.96-.27 1.98-.4 3-.41 1.02.01 2.04.14 3 .41 2.29-1.59 3.3-1.26 3.3-1.26.66 1.7.24 2.97.12 3.28.78.86 1.24 1.95 1.24 3.29 0 4.69-2.81 5.72-5.49 6.02.43.38.81 1.14.81 2.3 0 1.66-.02 3-.02 3.41 0 .32.22.71.82.58 4.76-1.56 8.2-6 8.2-11.21C23.5 5.78 18.35.5 12 .5z" />
          </svg>
          <span className="sr-only">GitHub</span>
        </a>
      </header>

      <section className="card stage-fade stage-fade-delay-2">
        <div className="step-header">
          <h2>
            <span className="heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
                <path d="M12 3l4 4h-3v6h-2V7H8l4-4zM5 15h14v4H5v-4z" />
              </svg>
            </span>
            Step 1 · Upload
          </h2>
          <button
            className="help-button pressable"
            type="button"
            onClick={() => setShowExportHelp((previous) => !previous)}
            aria-expanded={showExportHelp}
            aria-controls="export-help"
          >
            How to export
          </button>
        </div>
        <p>Drag and drop the BeReal export zip, or browse your files.</p>
        {showExportHelp ? (
          <div id="export-help" className="help-panel section-enter">
            <p className="help-panel-title">In the BeReal app:</p>
            <ol>
              <li>Open BeReal and go to Settings.</li>
              <li>Follow: Help → Contact → Ask a Question → Guidelines → Everything else → More Help.</li>
              <li>Select “I want a copy of my data”.</li>
              <li>Download the zip when it arrives, then upload it here.</li>
            </ol>
          </div>
        ) : null}
        <label
          className={`dropzone ${dragging ? "dragging" : ""} ${file ? `uploaded upload-flash-${uploadAnimationTick % 2}` : ""} ${inputsDisabled ? "disabled" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            if (inputsDisabled) return;
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" accept=".zip" onChange={onBrowse} disabled={inputsDisabled} />
          <strong>{file ? "Replace zip" : "Choose zip file"}</strong>
          <p>Upload the original exported .zip you got from BeReal</p>
          {file ? (
            <span
              key={`${file.name}-${file.size}-${file.lastModified}-${uploadAnimationTick}`}
              className="file-pill file-pill-enter"
            >
              {file.name} · {formattedSize}
              <button
                className="file-clear pressable"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  if (inputsDisabled) return;
                  void handleFile(null);
                }}
                aria-label="Remove uploaded file"
                disabled={inputsDisabled}
              >
                x
              </button>
            </span>
          ) : null}
        </label>
      </section>

      {file ? (
        <>
          <section className="card section-enter section-enter-delay-1" style={{ marginTop: 24 }}>
            <h2 style={{ marginBottom: 12 }}>
              <span className="heading-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
                  <path d="M4 7h10v2H4V7zm0 8h16v2H4v-2zm0-4h16v2H4v-2zm12-4h4v2h-4V7z" />
                </svg>
              </span>
              Step 2 · Adjust settings
            </h2>
            <div className="field">
              <label
                className={`toggle ${inputsDisabled ? "disabled" : ""}`}
                onClick={() => toggle("createCombinedImages")}
                onKeyDown={handleToggleKey("createCombinedImages")}
                role="button"
                tabIndex={inputsDisabled ? -1 : 0}
                aria-disabled={inputsDisabled}
              >
                <div>
                  <span>Create combined memories</span>
                  <small>Stitches primary + secondary shots. Singles export only when off.</small>
                </div>
                <div className={`switch ${settings.createCombinedImages ? "active" : ""}`} />
              </label>
              <label
                className={`toggle ${inputsDisabled ? "disabled" : ""}`}
                onClick={() => toggle("rearPhotoLarge")}
                onKeyDown={handleToggleKey("rearPhotoLarge")}
                role="button"
                tabIndex={inputsDisabled ? -1 : 0}
                aria-disabled={inputsDisabled}
              >
                <div>
                  <span>Rear photo large</span>
                  <small>If off, the front photo becomes large instead.</small>
                </div>
                <div className={`switch ${settings.rearPhotoLarge ? "active" : ""}`} />
              </label>
            </div>

            <div className="date-filters">
              {isDetectingDateBounds ? (
                <p className="date-range-hint">Reading available dates from your export…</p>
              ) : null}
              <div className="field">
                <label htmlFor="since-date">Start date filter</label>
                <input
                  id="since-date"
                  className="date-input"
                  type="date"
                  value={settings.sinceDate}
                  min={dateBounds?.earliestDate}
                  max={settings.endDate || dateBounds?.latestDate}
                  disabled={dateInputsDisabled}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      sinceDate: event.target.value
                    }))
                  }
                />
              </div>
              <div className="field">
                <label htmlFor="end-date">End date filter</label>
                <input
                  id="end-date"
                  className="date-input"
                  type="date"
                  value={settings.endDate}
                  min={settings.sinceDate || dateBounds?.earliestDate}
                  max={dateBounds?.latestDate}
                  disabled={dateInputsDisabled}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      endDate: event.target.value
                    }))
                  }
                />
              </div>
            </div>

            <div className="field">
              <label htmlFor="export-format">Export file format</label>
              <select
                id="export-format"
                className="date-input"
                value={settings.exportFormat}
                disabled={inputsDisabled}
                onChange={(event) =>
                  setSettings((previous) => ({
                    ...previous,
                    exportFormat: event.target.value as SettingsState["exportFormat"]
                  }))
                }
              >
                <option value="jpg">JPG (JPEG)</option>
                <option value="png">PNG</option>
              </select>
            </div>
          </section>

          <section className="card section-enter section-enter-delay-2" style={{ marginTop: 24 }}>
            <h2 style={{ marginBottom: 12 }}>
              <span className="heading-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
                  <path d="M12 1.75a10.25 10.25 0 1 0 10.25 10.25A10.26 10.26 0 0 0 12 1.75zm.75 5.5h-1.5v5.06l3.83 2.3.77-1.29-3.1-1.86z" />
                </svg>
              </span>
              Step 3 · Timezone settings
            </h2>
            <div className="field">
              <label htmlFor="fallback-timezone">Fallback timezone (for photos without location)</label>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "minmax(0, 1fr) auto",
                  gap: 10,
                  alignItems: "center"
                }}
              >
                <select
                  id="fallback-timezone"
                  className="date-input"
                  value={settings.fallbackTimezone}
                  disabled={inputsDisabled}
                  onChange={(event) =>
                    setSettings((previous) => ({
                      ...previous,
                      fallbackTimezone: event.target.value
                    }))
                  }
                >
                  <option value="">Select a fallback timezone</option>
                  {fallbackTimezoneOptions.map((timeZone) => (
                    <option key={timeZone} value={timeZone}>
                      {timeZone}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="help-button pressable"
                  disabled={inputsDisabled}
                  onClick={() => {
                    setShowTimezoneOverrides((previous) => !previous);
                  }}
                  aria-expanded={showTimezoneOverrides}
                  aria-controls="timezone-overrides-panel"
                >
                  {showTimezoneOverrides ? "Close" : "Set Timespans"}
                </button>
              </div>
              {showTimezoneOverrides ? (
                <div
                  id="timezone-overrides-panel"
                  className="help-panel section-enter"
                  style={{ marginTop: 12 }}
                >
                  <p className="help-panel-title">Fallback timezone timespans</p>
                  <p style={{ marginTop: 0, marginBottom: 12 }}>
                    Only used when a photo has no location in <code>posts.json</code>. Later entries override earlier
                    ones if date ranges overlap.
                  </p>
                  {settings.timezoneOverrides.length === 0 ? (
                    <p style={{ marginBottom: 12 }}>No timespans added yet.</p>
                  ) : null}
                  <div className="timezone-overrides-list">
                    {settings.timezoneOverrides.map((override, index) => (
                      <div key={index} className="timezone-override-card">
                        <div className="timezone-override-grid">
                          <div className="timezone-override-field">
                            <label className="timezone-override-label" htmlFor={`tz-span-start-${index}`}>
                              Start
                            </label>
                            <input
                              id={`tz-span-start-${index}`}
                              className="date-input"
                              type="date"
                              value={override.startDate}
                              max={override.endDate || undefined}
                              disabled={inputsDisabled}
                              onChange={(event) =>
                                updateTimezoneOverride(index, { startDate: event.target.value })
                              }
                            />
                          </div>
                          <div className="timezone-override-field">
                            <label className="timezone-override-label" htmlFor={`tz-span-end-${index}`}>
                              End
                            </label>
                            <input
                              id={`tz-span-end-${index}`}
                              className="date-input"
                              type="date"
                              value={override.endDate}
                              min={override.startDate || undefined}
                              disabled={inputsDisabled}
                              onChange={(event) =>
                                updateTimezoneOverride(index, { endDate: event.target.value })
                              }
                            />
                          </div>
                          <div className="timezone-override-field timezone-override-field-zone">
                            <label className="timezone-override-label" htmlFor={`tz-span-zone-${index}`}>
                              Timezone
                            </label>
                            <select
                              id={`tz-span-zone-${index}`}
                              className="date-input"
                              value={override.timeZone}
                              disabled={inputsDisabled}
                              onChange={(event) =>
                                updateTimezoneOverride(index, { timeZone: event.target.value })
                              }
                            >
                              <option value="">Select timezone</option>
                              {fallbackTimezoneOptions.map((timeZone) => (
                                <option key={timeZone} value={timeZone}>
                                  {timeZone}
                                </option>
                              ))}
                            </select>
                          </div>
                          <button
                            type="button"
                            className="timezone-override-remove pressable-subtle"
                            disabled={inputsDisabled}
                            aria-label={`Remove timezone timespan ${index + 1}`}
                            onClick={() => {
                              removeTimezoneOverride(index);
                            }}
                          >
                            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                              <path d="M9 3h6l1 2h4v2H4V5h4l1-2zm1 6h2v8h-2V9zm4 0h2v8h-2V9zM7 9h2v8H7V9zm1 12h8a2 2 0 0 0 2-2V8H6v11a2 2 0 0 0 2 2z" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="help-button pressable"
                      disabled={inputsDisabled}
                      onClick={addTimezoneOverride}
                    >
                      Add timespan
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="card section-enter section-enter-delay-3" style={{ marginTop: 24 }}>
            <h2 style={{ marginBottom: 12 }}>
              <span className="heading-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
                  <path d="M5 4h14v2H5V4zm0 4h8v2H5V8zm0 6h14v2H5v-2zm0 4h10v2H5v-2z" />
                </svg>
              </span>
              Step 4 · Process & export
            </h2>
            <div className="process-layout">
              <div className="process-left">
                {!downloadUrl && !isProcessing ? (
                  <button
                    className="primary-action pressable"
                    onClick={handleSubmit}
                    disabled={isProcessing || isDetectingDateBounds}
                  >
                    {isDetectingDateBounds ? "Reading dates…" : "Process locally"}
                  </button>
                ) : null}

                {isProcessing ? (
                  <div className="progress progress-active section-enter">
                    <div className="progress-meta">
                      <span className="progress-label">
                        <span className="progress-orb" aria-hidden="true" />
                        {progressLabel}
                      </span>
                      <span className="progress-percent">{progress.percent}%</span>
                    </div>
                    <div
                      className="progress-track"
                      role="progressbar"
                      aria-valuemin={0}
                      aria-valuemax={100}
                      aria-valuenow={progress.percent}
                      aria-label={progressLabel}
                    >
                      <div className="progress-bar" style={{ width: `${progress.percent}%` }} />
                    </div>
                  </div>
                ) : null}

                {status ? (
                  <div className="status status-enter" style={{ marginTop: 16 }}>
                    {status}
                  </div>
                ) : null}
                {error ? (
                  <div
                    className="status status-enter"
                    style={{
                      marginTop: 16,
                      background: "#fef2f2",
                      color: "#991b1b",
                      borderColor: "#fecaca"
                    }}
                  >
                    {error}
                  </div>
                ) : null}
                {warnings.length > 0 ? (
                  <div
                    className="status status-enter"
                    style={{
                      marginTop: 16,
                      background: "#fff7ed",
                      color: "#9a3412",
                      borderColor: "#fed7aa"
                    }}
                  >
                    <strong>Warnings ({warnings.length})</strong>
                    <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                      {warnings.slice(0, 8).map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                    {warnings.length > 8 ? <p style={{ marginTop: 8 }}>Only the first 8 are shown.</p> : null}
                  </div>
                ) : null}
              </div>

              {downloadUrl ? (
                <div className="process-right section-enter section-enter-delay-1">
                  <div className="result-card result-card-ready">
                    <div className="result-title">Export ready</div>
                    {exportedCount !== null ? (
                      <div className="exported-count">
                        Exported {exportedCount} image{exportedCount === 1 ? "" : "s"}.
                      </div>
                    ) : null}
                    <div className="actions actions-vertical">
                      <a
                        className="download pressable"
                        href={downloadUrl}
                        download={downloadName ?? "bereal-processed.zip"}
                      >
                        <span className="button-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
                            <path d="M12 3v10l3.5-3.5 1.4 1.4L12 16.8 7.1 10.9l1.4-1.4L11 13V3h1zM5 19h14v2H5v-2z" />
                          </svg>
                        </span>
                        Download zip
                      </a>
                      <button className="action-button pressable" type="button" onClick={handleExportToGallery}>
                        <span className="button-icon" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="18" height="18" focusable="false">
                            <path d="M5 5h14v10H5V5zm2 2v6h10V7H7zm-2 10h14v2H5v-2zm4-6 2-2 3 3 2-2 3 3H7z" />
                          </svg>
                        </span>
                        Save to Phone Gallery
                      </button>
                      <button className="share-text pressable-subtle" type="button" onClick={handleShareSite}>
                        {shareButtonText}
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </section>
        </>
      ) : null}

      <section className="card stage-fade stage-fade-delay-3" style={{ marginTop: 24 }}>
        <h2>
          <span className="heading-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" focusable="false">
              <path d="M12 3l7 4v5c0 4.4-3 8.4-7 9-4-0.6-7-4.6-7-9V7l7-4zm0 4.1L7 8.9v3.1c0 3.2 2 6.3 5 6.9 3-0.6 5-3.7 5-6.9V8.9l-5-1.8z" />
            </svg>
          </span>
          Privacy
        </h2>
        <p>
          All processing happens locally on your device in this browser, and your files are not uploaded to any server
          by this app.
        </p>
      </section>

      <footer className="footer stage-fade stage-fade-delay-4">
        <span>Created with ❤️ by Mirza Polat</span>
        <p className="footer-disclaimer">
          Independent tool. This app is not affiliated with, approved by, or linked to BeReal.
        </p>
      </footer>
    </main>
  );
}
