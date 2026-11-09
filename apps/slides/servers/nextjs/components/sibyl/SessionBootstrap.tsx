"use client";

// Importing the module installs the base-path/owner-token fetch glue as soon
// as the client bundle evaluates, before any page component fetches.
import { installSibylSession } from "./session";

installSibylSession();

export function SessionBootstrap() {
  return null;
}
