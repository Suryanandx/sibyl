/**
 * @open-gpt-live/core — shared contracts for Sibyl's server side.
 *
 * Every capability (brain tool loop, built-in tools, MCP, slides, routines,
 * approvals, metering, storage) is built against these interfaces so each
 * exists exactly once and parts can be developed independently.
 */
export * from "./tools";
export * from "./store";
export * from "./usage";

/** Single-owner deployments use this owner id. */
export const DEFAULT_OWNER_ID = "owner";
