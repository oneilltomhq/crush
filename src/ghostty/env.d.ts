// Ambient declarations for ghostty.ts loader paths we don't use in browser
declare const Bun: any;
declare module 'fs/promises' {
  export function readFile(path: string): Promise<Buffer>;
}
