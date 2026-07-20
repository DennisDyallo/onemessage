#!/usr/bin/env bun

import { loadConfig } from "../src/config.ts";
import { backfillInstagramThreadMetadata } from "../src/providers/instagram.ts";

const args = process.argv.slice(2);
const overrides: Record<string, string> = {};
for (let index = 0; index < args.length; index++) {
  if (args[index] !== "--title") continue;
  const value = args[index + 1];
  if (!value) throw new Error("--title requires THREAD_ID=DISPLAY_NAME");
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) {
    throw new Error("--title requires THREAD_ID=DISPLAY_NAME");
  }
  overrides[value.slice(0, separator)] = value.slice(separator + 1);
  index++;
}

const account = loadConfig().instagram?.username;
if (!account) throw new Error("Instagram is not configured");

const threads = backfillInstagramThreadMetadata(account, overrides);
console.log(JSON.stringify({ account, threads: threads.length, resolved: threads.filter((thread) => thread.resolved).length }));
