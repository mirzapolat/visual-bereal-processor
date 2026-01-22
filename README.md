# BeReal Photo Processor

Process your BeReal GDPR export photos into clean, dated JPEGs with optional combined "memory" images. The script keeps EXIF/IPTC metadata, supports a date cutoff, and offers either concise progress bars or full logs.

## What it does
- Converts WebP to JPEG (optional).
- Renames files with capture timestamps.
- Adds EXIF/IPTC metadata (date, location, caption).
- Builds combined images like BeReal memories (optional).
- Filters entries by a start date (optional).
- Cleans up temporary files and moves results next to the script.

## Step 1: Install Python

Choose one option that fits your system.

### macOS
1. Install Homebrew if needed: `https://brew.sh`
2. Install Python:
   ```bash
   brew install python
   ```

### Windows
1. Download Python from `https://www.python.org/downloads/`
2. Run the installer and check **Add Python to PATH**.

### Linux (Debian/Ubuntu)
```bash
sudo apt update
sudo apt install python3 python3-pip
```

## Step 2: Install dependencies

From the folder containing `bereal-process-photos.py`, run:
```bash
python3 -m pip install pillow piexif iptcinfo3
```

If `python3` is not available on your system, use:
```bash
python -m pip install pillow piexif iptcinfo3
```

## Step 3: Prepare your export

Place your BeReal export files like this:
```
the-folder-you-downloaded/
  bereal-process-photos.py
  posts.json
  Photos/
    post/
      (WebP images are here)
    ...
  ...
```

## Step 4: Run the script

```bash
python3 bereal-process-photos.py
```

You will see a startup menu where you can adjust settings one by one:
1. Convert images to JPEG
2. Keep original filenames
3. Create combined images
4. Filter by start date (YYYY-MM-DD)
5. Delete processed single files after combining
6. Output style (progress bars or verbose logs)

When finished, the output folders are moved next to the script:
```
__processed/
__combined/
```

## Notes
- If you enable JPEG conversion, any leftover WebP files in the output folders are removed at the end.
- If a destination folder already exists, the script adds a numeric suffix like `__processed_1`.

## Optional Next.js UI
If you want a visual interface for this script, run the Next.js app in this repo:

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` and upload your BeReal export zip. The UI invokes the Python script locally, so keep the Python dependencies installed:

```bash
python3 -m pip install pillow piexif iptcinfo3
```

## Docker (recommended for hosting)
The Docker image includes Node.js plus the Python dependencies, so visitors do not need anything installed.

```bash
docker build -t visual-bereal-processor .
docker run --rm -p 3000:3000 visual-bereal-processor
```

Open `http://localhost:3000` (or your server IP) and upload the BeReal export zip. The container processes it and returns a zip.

## Credits
This was originally forked from [hatobi/bereal-gdpr-photo-toolkit](https://github.com/hatobi/bereal-gdpr-photo-toolkit) and then modified.
