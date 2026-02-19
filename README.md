# BeReal Photo Processor (Browser-Local)

Process a BeReal GDPR export zip directly in your browser with no Python installation.

## What it does
- Reads your BeReal export zip (`posts.json` + `Photos/`) locally in the browser.
- Converts source images to JPG or PNG.
- Renames files with capture timestamps.
- Applies date filters.
- Creates combined memory-style images (optional).
- Adds EXIF and IPTC metadata for JPG outputs (capture date and caption, plus GPS in EXIF).
- Downloads a processed zip archive.

## Notes
- JPG output includes both EXIF and IPTC metadata when possible.

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
