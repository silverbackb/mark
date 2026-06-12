#!/usr/bin/env node
if (process.argv[2] === "init") {
  await import("./init.js");
} else {
  await import("./index.js");
}
