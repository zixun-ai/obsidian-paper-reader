// Type declarations for pdfjs-dist legacy subpath imports.
// The legacy build is transpiled for wider Electron/Chromium compatibility
// and ships its own .d.mts next to the .mjs files, but "node" module
// resolution does not pick those up, so we re-export the root types here.
declare module "pdfjs-dist/legacy/build/pdf.mjs" {
	export * from "pdfjs-dist";
}
