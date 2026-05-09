#!/usr/bin/env node
import { runOperatorCli } from "./operatorEntrypoint.js";

runOperatorCli(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
