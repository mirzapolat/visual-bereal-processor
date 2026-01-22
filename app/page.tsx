"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type SettingsState = {
  exportFormat: "jpg" | "png" | "heic";
  createCombinedImages: boolean;
  rearPhotoLarge: boolean;
  sinceDate: string;
  endDate: string;
};

type ToggleKey = "createCombinedImages" | "rearPhotoLarge";

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
  endDate: ""
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [settings, setSettings] = useState<SettingsState>(initialSettings);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [showExportHelp, setShowExportHelp] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [exportedCount, setExportedCount] = useState<number | null>(null);
  const [progress, setProgress] = useState({
    stage: "queued",
    percent: 0,
    current: 0,
    total: 0
  });

  const toggle = (key: ToggleKey) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggleKey =
    (key: ToggleKey) => (event: React.KeyboardEvent<HTMLLabelElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(key);
      }
    };

  const handleFile = useCallback((newFile: File | null) => {
    setFile(newFile);
    setError(null);
    setStatus(null);
    setDownloadUrl(null);
    setJobId(null);
    setIsProcessing(false);
    setExportedCount(null);
    setProgress({
      stage: "queued",
      percent: 0,
      current: 0,
      total: 0
    });
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLLabelElement>) => {
      event.preventDefault();
      setDragging(false);
      const droppedFile = event.dataTransfer.files?.[0];
      if (droppedFile) {
        handleFile(droppedFile);
      }
    },
    [handleFile]
  );

  const onBrowse = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const newFile = event.target.files?.[0] ?? null;
      handleFile(newFile);
    },
    [handleFile]
  );

  const formattedSize = useMemo(() => {
    if (!file) return "";
    const mb = file.size / 1024 / 1024;
    return `${mb.toFixed(2)} MB`;
  }, [file]);

  const progressLabel = useMemo(() => {
    const stageMap: Record<string, string> = {
      queued: "Waiting to start",
      starting: "Preparing files",
      processing: "Processing entries",
      combining: "Combining images",
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

  useEffect(() => {
    if (!jobId || !isProcessing) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const response = await fetch(`/api/process?jobId=${jobId}`);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(data?.error || "Could not fetch processing status.");
        }

        if (cancelled) return;

        setProgress({
          stage: data?.stage ?? "processing",
          percent: data?.percent ?? 0,
          current: data?.current ?? 0,
          total: data?.total ?? 0
        });

        if (data?.status === "ready") {
          setIsProcessing(false);
          setDownloadUrl(data?.downloadUrl ?? null);
          if (typeof data?.exportedCount === "number") {
            setExportedCount(data.exportedCount);
            setStatus(
              `Processing finished. ${data.exportedCount} images exported. Files are ready to download.`
            );
          } else {
            setStatus("Processing finished. Files are ready to download.");
          }
          return;
        }

        if (data?.status === "error") {
          setIsProcessing(false);
          setError(data?.error || "Processing failed.");
          setStatus(null);
          setExportedCount(null);
          return;
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : "Status check failed.";
        setIsProcessing(false);
        setError(message);
        setStatus(null);
        setExportedCount(null);
      }
    };

    poll();
    const interval = window.setInterval(poll, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [jobId, isProcessing]);

  const handleShareSite = useCallback(async () => {
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
        // ignore user cancellation
      }
    }
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(window.location.href);
        setStatus("Link copied to clipboard.");
      } else {
        setStatus("Copy the page URL to share with friends.");
      }
    } catch {
      setStatus("Copy the page URL to share with friends.");
    }
  }, []);

  const handleExportToGallery = useCallback(async () => {
    if (!downloadUrl) return;
    if (!navigator.share) {
      setStatus("Sharing files is not supported on this device.");
      return;
    }

    setStatus("Preparing files for sharing…");
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error("Failed to download the processed archive.");
      }
      const blob = await response.blob();
      const file = new File([blob], "bereal-processed.zip", { type: "application/zip" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        setStatus("Sharing files is not supported on this device.");
        return;
      }
      await navigator.share({
        title: "BeReal memories",
        files: [file]
      });
      setStatus("Share sheet opened.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unable to share files.";
      setError(message);
      setStatus(null);
    }
  }, [downloadUrl]);

  const handleSubmit = async () => {
    if (!file) {
      setError("Please upload your BeReal export zip file first.");
      return;
    }

    setLoading(true);
    setStatus("Starting processing…");
    setError(null);
    setDownloadUrl(null);
    setIsProcessing(false);
    setJobId(null);
    setExportedCount(null);
    setProgress({
      stage: "starting",
      percent: 0,
      current: 0,
      total: 0
    });

    try {
      const payload = new FormData();
      payload.append("file", file);
      payload.append("settings", JSON.stringify(settings));

      const response = await fetch("/api/process", {
        method: "POST",
        body: payload
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || "Something went wrong while starting processing.");
      }

      if (!data?.jobId) {
        throw new Error("Missing job id from server.");
      }

      setJobId(data.jobId);
      setIsProcessing(true);
      setStatus("Processing your export…");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Processing failed.";
      setError(message);
      setStatus(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <main>
      <header className="topbar">
        <div>
          <div className="logo">GDPR BeReal Processor</div>
          <p className="tagline">
            Export your BeReal data to your phone's mobile gallery just as your normal memories look like in the app.
          </p>
        </div>
        <a
          className="github-button"
          href="https://github.com/mirzapolat/visual-bereal-processor"
          target="_blank"
          rel="noreferrer"
          aria-label="View on GitHub"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 .5C5.65.5.5 5.78.5 12.3c0 5.22 3.44 9.65 8.2 11.21.6.12.82-.26.82-.58 0-.29-.01-1.04-.02-2.05-3.34.75-4.04-1.65-4.04-1.65-.55-1.42-1.34-1.8-1.34-1.8-1.1-.78.08-.77.08-.77 1.22.09 1.86 1.27 1.86 1.27 1.08 1.92 2.84 1.37 3.53 1.05.11-.8.42-1.37.76-1.68-2.66-.31-5.46-1.35-5.46-6.03 0-1.34.46-2.43 1.24-3.29-.12-.31-.54-1.58.12-3.28 0 0 1.01-.33 3.3 1.26.96-.27 1.98-.4 3-.41 1.02.01 2.04.14 3 .41 2.29-1.59 3.3-1.26 3.3-1.26.66 1.7.24 2.97.12 3.28.78.86 1.24 1.95 1.24 3.29 0 4.69-2.81 5.72-5.49 6.02.43.38.81 1.14.81 2.3 0 1.66-.02 3-.02 3.41 0 .32.22.71.82.58 4.76-1.56 8.2-6 8.2-11.21C23.5 5.78 18.35.5 12 .5z" />
          </svg>
          <span className="sr-only">GitHub</span>
        </a>
      </header>

      <section className="card">
        <div className="step-header">
          <h2>
            <span className="heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M12 3l4 4h-3v6h-2V7H8l4-4zM5 15h14v4H5v-4z" />
              </svg>
            </span>
            Step 1 · Upload your export
          </h2>
          <button
            className="help-button"
            type="button"
            onClick={() => setShowExportHelp((prev) => !prev)}
            aria-expanded={showExportHelp}
            aria-controls="export-help"
          >
            How to export
          </button>
        </div>
        <p>Drag and drop the BeReal export zip, or browse your files.</p>
        {showExportHelp ? (
          <div id="export-help" className="help-panel">
            <ol>
              <li>Open BeReal and go to Settings.</li>
              <li>Follow: Help → Contact → Ask a Question → Guidelines → Everything else → More Help.</li>
              <li>Select “I want a copy of my data”.</li>
              <li>Download the zip when it arrives, then upload it here.</li>
            </ol>
          </div>
        ) : null}
        <label
          className={`dropzone ${dragging ? "dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <input type="file" accept=".zip" onChange={onBrowse} />
          <strong>{file ? "Replace zip" : "Choose zip file"}</strong>
          <p>Keep the export structure intact.</p>
          {file ? (
            <span className="file-pill">
              {file.name} · {formattedSize}
              <button
                className="file-clear"
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleFile(null);
                }}
                aria-label="Remove uploaded file"
              >
                x
              </button>
            </span>
          ) : null}
        </label>
      </section>

      {file ? (
        <section className="card" style={{ marginTop: 24 }}>
          <h2 style={{ marginBottom: 12 }}>
            <span className="heading-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M4 7h10v2H4V7zm0 8h16v2H4v-2zm0-4h16v2H4v-2zm12-4h4v2h-4V7z" />
              </svg>
            </span>
            Step 2 · Adjust settings
          </h2>
          <div className="field">
            <label
              className="toggle"
              onClick={() => toggle("createCombinedImages")}
              onKeyDown={handleToggleKey("createCombinedImages")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Create combined memories</span>
                <small>Stitches primary + secondary shots. Singles export only when off.</small>
              </div>
              <div className={`switch ${settings.createCombinedImages ? "active" : ""}`} />
            </label>
            <label
              className="toggle"
              onClick={() => toggle("rearPhotoLarge")}
              onKeyDown={handleToggleKey("rearPhotoLarge")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Rear photo large</span>
                <small>If off, the front photo becomes large instead.</small>
              </div>
              <div className={`switch ${settings.rearPhotoLarge ? "active" : ""}`} />
            </label>
          </div>

          <div className="date-filters">
            <div className="field">
              <label htmlFor="since-date">Start date filter</label>
              <input
                id="since-date"
                className="date-input"
                type="date"
                value={settings.sinceDate}
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
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
                onChange={(event) =>
                  setSettings((prev) => ({
                    ...prev,
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
              onChange={(event) =>
                setSettings((prev) => ({
                  ...prev,
                  exportFormat: event.target.value as SettingsState["exportFormat"]
                }))
              }
            >
              <option value="jpg">JPG (JPEG)</option>
              <option value="png">PNG</option>
              <option value="heic">HEIC</option>
            </select>
          </div>

          <button
            className="primary-action"
            onClick={handleSubmit}
            disabled={loading || isProcessing}
          >
            {loading ? "Starting…" : isProcessing ? "Processing…" : "Process"}
          </button>

          {isProcessing ? (
            <div className="progress">
              <div className="progress-meta">
                <span>{progressLabel}</span>
                <span>{progress.percent}%</span>
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
            <div className="status" style={{ marginTop: 16 }}>
              {status}
            </div>
          ) : null}
          {error ? (
            <div
              className="status"
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

          {downloadUrl ? (
            <>
              {exportedCount !== null ? (
                <div className="exported-count">
                  Exported {exportedCount} image{exportedCount === 1 ? "" : "s"}.
                </div>
              ) : null}
              <div className="actions">
                <a className="download" href={downloadUrl} download="bereal-processed.zip">
                  <span className="button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 3v10l3.5-3.5 1.4 1.4L12 16.8 7.1 10.9l1.4-1.4L11 13V3h1zM5 19h14v2H5v-2z" />
                    </svg>
                  </span>
                  Download zip
                </a>
                <button className="action-button" type="button" onClick={handleExportToGallery}>
                  <span className="button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 3l4 4h-3v6h-2V7H8l4-4zM5 15h14v4H5v-4z" />
                    </svg>
                  </span>
                  Export to phone gallery
                </button>
                <button className="action-button ghost" type="button" onClick={handleShareSite}>
                  <span className="button-icon" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M14 9l-4 2.3v3.4L14 17v-2.1l6 3.1V6l-6 3zM4 6h6v2H6v8h4v2H4V6z" />
                    </svg>
                  </span>
                  Share this website
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      <section className="card" style={{ marginTop: 24 }}>
        <h2>
          <span className="heading-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3l7 4v5c0 4.4-3 8.4-7 9-4-0.6-7-4.6-7-9V7l7-4zm0 4.1L7 8.9v3.1c0 3.2 2 6.3 5 6.9 3-0.6 5-3.7 5-6.9V8.9l-5-1.8z" />
            </svg>
          </span>
          Privacy
        </h2>
        <p>
          Your upload is used only to generate your export. Files are stored
          temporarily during processing and removed shortly after (or when you
          download the zip). We don’t retain or share your data.
        </p>
      </section>

      <footer className="footer">
        <span>Created with ❤️ by Mirza Polat</span>
      </footer>
    </main>
  );
}
