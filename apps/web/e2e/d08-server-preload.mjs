// Test-only IPC bridge so the isolated D08 server can take its normal SIGINT
// shutdown path before it is restarted against the same PGlite directory.
process.on("message", (message) => {
  if (message && typeof message === "object" && message.type === "T60_D08_SHUTDOWN") {
    process.emit("SIGINT");
    if (typeof process.disconnect === "function" && process.connected) process.disconnect();
  }
});
