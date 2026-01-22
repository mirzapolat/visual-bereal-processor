"use client";

import { useCallback, useMemo, useState } from "react";

type SettingsState = {
  convertToJpeg: boolean;
  keepOriginalFilename: boolean;
  createCombinedImages: boolean;
  deleteProcessedFilesAfterCombining: boolean;
  verboseLogging: boolean;
  sinceDate: string;
};

const initialSettings: SettingsState = {
  convertToJpeg: true,
  keepOriginalFilename: false,
  createCombinedImages: true,
  deleteProcessedFilesAfterCombining: true,
  verboseLogging: false,
  sinceDate: ""
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

  const toggle = (key: keyof SettingsState) => {
    setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const handleToggleKey =
    (key: keyof SettingsState) => (event: React.KeyboardEvent<HTMLLabelElement>) => {
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

  const handleSubmit = async () => {
    if (!file) {
      setError("Please upload your BeReal export zip file first.");
      return;
    }

    setLoading(true);
    setStatus("Processing your export…");
    setError(null);

    try {
      const payload = new FormData();
      payload.append("file", file);
      payload.append("settings", JSON.stringify(settings));

      const response = await fetch("/api/process", {
        method: "POST",
        body: payload
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data?.error || "Something went wrong while processing.");
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      setDownloadUrl(url);
      setStatus("Your archive is ready.");
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
          <h2>Step 1 · Upload your export</h2>
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
            </span>
          ) : null}
        </label>
      </section>

      {file ? (
        <section className="card" style={{ marginTop: 24 }}>
          <h2>Step 2 · Adjust settings</h2>
          <div className="field">
            <label
              className="toggle"
              onClick={() => toggle("convertToJpeg")}
              onKeyDown={handleToggleKey("convertToJpeg")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Convert WebP to JPEG</span>
                <small>Also embeds EXIF + IPTC metadata.</small>
              </div>
              <div className={`switch ${settings.convertToJpeg ? "active" : ""}`} />
            </label>
            <label
              className="toggle"
              onClick={() => toggle("keepOriginalFilename")}
              onKeyDown={handleToggleKey("keepOriginalFilename")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Keep original filenames</span>
                <small>Appends the original name after the timestamp.</small>
              </div>
              <div className={`switch ${settings.keepOriginalFilename ? "active" : ""}`} />
            </label>
            <label
              className="toggle"
              onClick={() => toggle("createCombinedImages")}
              onKeyDown={handleToggleKey("createCombinedImages")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Create combined memories</span>
                <small>Stitches primary + secondary shots.</small>
              </div>
              <div className={`switch ${settings.createCombinedImages ? "active" : ""}`} />
            </label>
            <label
              className="toggle"
              onClick={() => toggle("deleteProcessedFilesAfterCombining")}
              onKeyDown={handleToggleKey("deleteProcessedFilesAfterCombining")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Delete singles after combining</span>
                <small>Keeps only combined images if enabled.</small>
              </div>
              <div
                className={`switch ${
                  settings.deleteProcessedFilesAfterCombining ? "active" : ""
                }`}
              />
            </label>
            <label
              className="toggle"
              onClick={() => toggle("verboseLogging")}
              onKeyDown={handleToggleKey("verboseLogging")}
              role="button"
              tabIndex={0}
            >
              <div>
                <span>Verbose logs</span>
                <small>More detailed processing output.</small>
              </div>
              <div className={`switch ${settings.verboseLogging ? "active" : ""}`} />
            </label>
          </div>

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

          <button className="primary-action" onClick={handleSubmit} disabled={loading}>
            {loading ? "Processing…" : "Process & Download"}
          </button>

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
            <div style={{ marginTop: 18 }}>
              <a className="download" href={downloadUrl} download="bereal-processed.zip">
                Download processed zip
              </a>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="card" style={{ marginTop: 24 }}>
        <h2>Privacy</h2>
        <p>
          Files are processed on the server and discarded immediately after the zip is
          generated.
        </p>
      </section>

      <footer className="footer">
        <span>Created with ❤️ by Mirza Polat</span>
      </footer>
    </main>
  );
}
