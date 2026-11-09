/**
 * Plugins (see docs/skills-and-plugins.md). Installed once by runtime.ts,
 * after skills, knowledge, secrets, routines and the Connections manager.
 */
export { PluginService, PluginError, loadPluginCatalog, pluginServerName, MAX_PLUGINS, type PluginServiceOptions } from "./service.js";
export { validateManifest, parseManifestText, summarize, ManifestError, MANIFEST_VERSION, MAX_MANIFEST_BYTES } from "./manifest.js";
export { fetchManifestText, gitManifestUrl, MANIFEST_FILE, type ManifestFetchDeps } from "./fetch.js";
export { handlePluginsHttp, isPluginsPath, type PluginsHttpOptions } from "./http.js";
