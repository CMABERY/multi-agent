#!/usr/bin/env node
import { createCli } from "./cli.js";

createCli().parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
