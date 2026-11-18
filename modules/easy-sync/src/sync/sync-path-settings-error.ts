export class SyncPathSettingsUpdateError extends Error {
  constructor(readonly code: "busy" | "recovery" | "invalid-pattern") {
    super(code);
    this.name = "SyncPathSettingsUpdateError";
  }
}
