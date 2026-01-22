declare module "adm-zip" {
  class AdmZip {
    constructor(zipFilePath?: string | Buffer);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
    getEntries(): Array<{ entryName: string; isDirectory: boolean }>;
  }

  export default AdmZip;
}
