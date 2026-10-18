#!/usr/bin/env node
import { main } from '../src/cli.mjs';
try { await main(); }
catch (error) { process.stderr.write(`Computer Use：${error.message}\n`); process.exitCode = 1; }
