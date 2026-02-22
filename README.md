# BeReal Gallery Backup

BeReal Gallery Backup is a browser-local web app that converts your BeReal export zip into gallery-ready images and gives you a downloadable processed zip.

Note: This is an independent project and is not affiliated with, approved by, or linked to BeReal.

## App
- Upload your BeReal export zip.
- Auto-detect available date range and filter by start/end date.
- Export as JPG or PNG.
- Create combined memory-style images, or export singles.
- Keep capture metadata in JPG exports (EXIF/IPTC when available).
- Process files locally in your browser.

## Deploy

### Local
```bash
npm install
npm run dev
```
Open [http://localhost:3000](http://localhost:3000).

### Production (Node)
```bash
npm install
npm run build
npm run start
```

### Docker
```bash
docker build -t visual-bereal-processor .
docker run --rm -p 3000:3000 visual-bereal-processor
```

### Vercel
```bash
npm install
npx vercel
npx vercel --prod
```
