#!/usr/bin/env node
import { runCli } from './commands.js';
try {
  process.exitCode = await runCli();
} catch (error) {
  console.error(error.message);
  process.exitCode = error.name === 'AbortError' ? 130 : 2;
}
