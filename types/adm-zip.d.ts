declare module "adm-zip" {
  class AdmZip {
    constructor(zipFilePath?: string | Buffer);
    extractAllTo(targetPath: string, overwrite?: boolean): void;
    addLocalFolder(localPath: string, zipPath?: string): void;
    getEntries(): Array<{
      entryName: string;
      isDirectory: boolean;
      getData(): Buffer;
    }>;
    toBuffer(): Buffer;
  }

  export default AdmZip;
}
