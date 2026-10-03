#!/usr/bin/env bun

// The CLI was renamed to manza in 1.0. This shim keeps `zazu` working for
// all of 1.x; it is removed in 2.0. A dynamic import so the notice prints
// before manza runs.
console.error("zazu is deprecated and will be removed in 2.0. Use manza instead.");
await import("./manza");

export {};
