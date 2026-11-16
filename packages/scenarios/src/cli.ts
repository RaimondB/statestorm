#!/usr/bin/env node
/** `node packages/scenarios/src/cli.ts <domain folder> | <model.yaml> <scenario|dir> [...] [--schedules] [--trace[=name]]` */
import { test } from "./main.ts";

process.exit(test(process.argv.slice(2)));
