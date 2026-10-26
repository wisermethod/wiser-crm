// Only release/build.mjs supplies this esbuild define. Direct/local builds
// deliberately identify themselves as dev, never as a deploy-time variable.
declare const __WISER_RELEASE_VERSION__: string;
export const releaseVersion = typeof __WISER_RELEASE_VERSION__ === "undefined"
  ? "dev" : __WISER_RELEASE_VERSION__;
