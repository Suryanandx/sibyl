import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { build } from "esbuild";


let runtimeConfig;
let temporaryDirectory;

test.before(async () => {
  temporaryDirectory = await mkdtemp(
    path.join(tmpdir(), "presenton-runtime-provider-config-")
  );
  const entryFile = path.join(temporaryDirectory, "entry.ts");
  const outputFile = path.join(temporaryDirectory, "bundle.mjs");
  await writeFile(
    entryFile,
    `export { readRuntimeProviderConfig } from ${JSON.stringify(
      path.resolve("lib/runtime-provider-config.ts")
    )};
    export { IMAGE_PROVIDERS, GPT_IMAGE_2_QUALITY_OPTIONS } from ${JSON.stringify(
      path.resolve("utils/providerConstants.ts")
    )};`
  );
  await build({
    entryPoints: [entryFile],
    outfile: outputFile,
    bundle: true,
    platform: "node",
    format: "esm",
    tsconfig: path.resolve("tsconfig.json"),
    logLevel: "silent",
  });
  runtimeConfig = await import(
    `${pathToFileURL(outputFile).href}?cache=${Date.now()}`
  );
});

test.after(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("regular-user runtime config keeps provider choices and redacts secrets", async () => {
  const configPath = path.join(temporaryDirectory, "userConfig.json");
  await writeFile(
    configPath,
    JSON.stringify({
      LLM: "openrouter",
      OPENROUTER_MODEL: "openai/example-model",
      OPENROUTER_API_KEY: "shared-secret",
      IMAGE_PROVIDER: "pexels",
      PEXELS_API_KEY: "shared-image-secret",
      DISABLE_IMAGE_GENERATION: false,
      LLM_MAX_OUTPUT_TOKENS: 16384,
      AUTH_SECRET_KEY: "private-signing-key",
      AUTH_PASSWORD_HASH: "private-password-hash",
      AUTH_USERNAME: "private-account",
    })
  );
  const previousPath = process.env.USER_CONFIG_PATH;
  process.env.USER_CONFIG_PATH = configPath;

  try {
    const result = runtimeConfig.readRuntimeProviderConfig();
    assert.equal(result.configured, true);
    assert.equal(result.config.LLM, "openrouter");
    assert.equal(result.config.OPENROUTER_MODEL, "openai/example-model");
    assert.equal(result.config.OPENROUTER_API_KEY, "__configured__");
    assert.equal(result.config.PEXELS_API_KEY, "__configured__");
    assert.equal(result.config.LLM_MAX_OUTPUT_TOKENS, 16384);
    assert.doesNotMatch(JSON.stringify(result), /shared-secret/);
    assert.doesNotMatch(JSON.stringify(result), /shared-image-secret/);
    assert.doesNotMatch(JSON.stringify(result), /AUTH_|private-signing-key|private-password-hash/);
  } finally {
    if (previousPath === undefined) delete process.env.USER_CONFIG_PATH;
    else process.env.USER_CONFIG_PATH = previousPath;
  }
});

test("runtime config migrates the removed DALL-E provider and keeps GPT Image 2 quality", async () => {
  const configPath = path.join(temporaryDirectory, "legacy-image-config.json");
  await writeFile(configPath, JSON.stringify({
    LLM: "openai", OPENAI_MODEL: "test-model", OPENAI_API_KEY: "shared-key",
    IMAGE_PROVIDER: "dall-e-3", DALL_E_3_QUALITY: "hd",
  }));
  const previousPath = process.env.USER_CONFIG_PATH;
  process.env.USER_CONFIG_PATH = configPath;
  try {
    const result = runtimeConfig.readRuntimeProviderConfig();
    assert.equal(result.configured, true);
    assert.equal(result.config.IMAGE_PROVIDER, "gpt-image-2");
    assert.equal(result.config.GPT_IMAGE_2_QUALITY, "high");
    assert.equal(result.config.OPENAI_API_KEY, "__configured__");
    assert.equal("DALL_E_3_QUALITY" in result.config, false);
  } finally {
    if (previousPath === undefined) delete process.env.USER_CONFIG_PATH;
    else process.env.USER_CONFIG_PATH = previousPath;
  }
});

test("image provider choices replace DALL-E 3 with GPT Image 2 and supported qualities", () => {
  assert.equal("dall-e-3" in runtimeConfig.IMAGE_PROVIDERS, false);
  const provider = runtimeConfig.IMAGE_PROVIDERS["gpt-image-2"];
  assert.equal(provider.value, "gpt-image-2");
  assert.equal(provider.label, "GPT Image 2");
  assert.equal(provider.apiKeyField, "OPENAI_API_KEY");
  assert.deepEqual(runtimeConfig.GPT_IMAGE_2_QUALITY_OPTIONS.map(({ value }) => value), [
    "low", "medium", "high",
  ]);
});
