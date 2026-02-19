declare module "piexifjs" {
  const piexif: {
    ExifIFD: Record<string, number>;
    ImageIFD: Record<string, number>;
    GPSIFD: Record<string, number>;
    dump: (data: unknown) => string;
    insert: (exifBytes: string, jpegDataUrl: string) => string;
  };

  export default piexif;
}
