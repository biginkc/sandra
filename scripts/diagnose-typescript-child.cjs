"use strict";

// Failure-only CI preload. Keep this deliberately narrow: it reports the
// TypeScript child's lifecycle without echoing its command line, environment,
// diagnostics, or any build input.
if (process.env.CI_DIAGNOSTIC_TYPESCRIPT_CHILD !== "1") {
  module.exports = {};
} else {
  const childProcess = require("node:child_process");
  const spawn = childProcess.spawn;
  const isTypeScriptChild = (command, args) => {
    const values = [command, ...(Array.isArray(args) ? args : [])].map(String);
    return values.some((value) =>
      /[/\\]typescript[/\\](?:bin|lib)[/\\]tsc(?:\.js)?$/.test(value),
    );
  };

  childProcess.spawn = function diagnosticSpawn(command, args, options) {
    const child = spawn.call(this, command, args, options);
    if (isTypeScriptChild(command, args)) {
      console.error(
        `[e2e-diagnostic] TypeScript child started pid=${child.pid ?? "unknown"}`,
      );
      child.once("error", (error) => {
        console.error(
          `[e2e-diagnostic] TypeScript child error name=${error?.name ?? "Error"}`,
        );
      });
      child.once("close", (code, signal) => {
        console.error(
          `[e2e-diagnostic] TypeScript child closed code=${code ?? "null"} signal=${signal ?? "none"}`,
        );
      });
    }
    return child;
  };
  module.exports = {};
}
