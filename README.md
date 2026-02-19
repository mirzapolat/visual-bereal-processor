# BeReal Photo Processor (Browser-Local)

Process a BeReal GDPR export zip directly in your browser with no Python installation.

## What it does
- Reads your BeReal export zip (`posts.json` + `Photos/`) locally in the browser.
- Converts source images to JPG or PNG.
- Renames files with capture timestamps.
- Applies date filters.
- Creates combined memory-style images (optional).
- Adds EXIF metadata for JPG outputs (capture date, location, caption).
- Downloads a processed zip archive.

## Notes
- HEIC output is not currently available in browser mode; selecting HEIC falls back to JPG.
- IPTC writing is not available in browser mode.

## Run locally
```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and upload your BeReal export zip.

## Production build
```bash
npm run build
npm run start
```

## Docker
```bash
docker build -t visual-bereal-processor .
docker run --rm -p 3000:3000 visual-bereal-processor
```

Then open [http://localhost:3000](http://localhost:3000).

## Credits
Originally forked from [hatobi/bereal-gdpr-photo-toolkit](https://github.com/hatobi/bereal-gdpr-photo-toolkit) and then adapted to a browser-native TypeScript implementation.
