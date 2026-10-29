// Single compile-time dev flag.
export const DEBUG_LOGGING = false;
export const dlog = (...args: unknown[]) => {
  if (DEBUG_LOGGING) {
    console.log("[autosave-control]", ...args);
  }
};
