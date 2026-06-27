// The package ships no types. Only the surface we use is declared.
declare module "@devicefarmer/adbkit-apkreader" {
  interface ApkManifest {
    package?: string;
    versionName?: string;
    // A raw number for normal builds; a Long-like object for >32-bit codes.
    versionCode?: number | { toString(): string };
    [key: string]: unknown;
  }
  class ApkReader {
    static open(apk: Buffer | string): Promise<ApkReader>;
    readManifest(): Promise<ApkManifest>;
  }
  export default ApkReader;
}
