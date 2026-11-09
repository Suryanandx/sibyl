'use client';
import { goToLibrary } from "@/utils/appLinks";

import { useEffect, useState } from 'react';
import { setUserRole, setLLMConfig } from '@/store/slices/userConfig';
import { hasValidLLMConfig, normalizeLLMConfig } from '@/utils/storeHelpers';
import { usePathname, useRouter } from 'next/navigation';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '@/store/store';
import { isOllamaModelAvailable } from '@/utils/providerUtils';
import { LLMConfig } from '@/types/llm_config';
import {
  assertBackendReachable,
  getApiUrl,
  isBackendConnectionError,
} from '@/utils/api';
import { notify } from '@/components/ui/sonner';
import { SibylSplash } from '@/components/sibyl/SibylLoader';
import { withBasePath } from '@/utils/basePath';

// Short minimum so the emblem does not flash.
const PRESENTON_SPLASH_MIN_DURATION_MS = 400;

function ConfigurationLoadingScreen() {
  return <SibylSplash message="Opening Sibyl Slides…" />;
}

export function ConfigurationInitializer({ children }: { children: React.ReactNode }) {
  const dispatch = useDispatch();
  const role = useSelector((state: RootState) => state.userConfig.role);
  const isAdmin = role === "admin";

  const route = usePathname();
  const shouldShowStartupSplash = !route?.startsWith("/pdf-maker");
  const isSettingsRoute =
    route === "/settings" || route?.startsWith("/settings/");
  const [isLoading, setIsLoading] = useState(
    () => shouldShowStartupSplash
  );
  const [hasMetSplashDuration, setHasMetSplashDuration] = useState(
    () => !shouldShowStartupSplash
  );
  const router = useRouter();

  // Fetch user config state
  useEffect(() => {
    fetchUserConfigState();
    // Configuration bootstrap runs once. Presenton is revalidated separately
    // below whenever the user navigates to another application route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (
      role === null ||
      route === '/' ||
      isSettingsRoute ||
      route.startsWith('/pdf-maker')
    ) {
      return;
    }

    let cancelled = false;
    let selectedProvider: string | undefined;
    const revalidateProviderConfiguration = async () => {
      try {
        const configResponse = await fetch(
          isAdmin ? '/api/user-config' : '/api/runtime-config',
          {
            cache: 'no-store',
          }
        );
        if (!configResponse.ok) {
          await assertBackendReachable();
          throw new Error(`provider config returned ${configResponse.status}`);
        }

        const payload = await configResponse.json();
        const config = normalizeLLMConfig(
          isAdmin ? payload : (payload.config || {})
        );
        const isConfigured = isAdmin
          ? hasValidLLMConfig(config)
          : Boolean(payload.configured);
        selectedProvider = config.LLM;
        dispatch(setLLMConfig(config));

        // A regular user's runtime config intentionally contains redacted
        // credentials. Trust the server-side validity result instead of
        // trying to validate secrets that the browser is not allowed to see.
        if (!isConfigured) {
          if (!cancelled) {
            notify.warning(
              "Provider setup required",
              isAdmin
                ? "Choose and configure a text provider before opening other pages."
                : "Ask the administrator to configure the AI providers in Settings.",
              { id: "provider-setup-required" }
            );
            if (isAdmin) goToLibrary();
          }
          return;
        }

        if (selectedProvider !== 'presenton') return;

        const statusResponse = await fetch(
          getApiUrl('/api/v1/auth/presenton/status'),
          { cache: 'no-store', credentials: 'include' }
        );
        if (!statusResponse.ok) {
          await assertBackendReachable();
          throw new Error(`Presenton status returned ${statusResponse.status}`);
        }
        const status = await statusResponse.json() as { linked?: boolean };

        if (!cancelled && !status?.linked) {
          dispatch(setLLMConfig({ ...config, LLM: '' }));
          notify.warning(
            "Provider setup required",
            "The selected provider is unavailable. Check the Sibyl model settings.",
            { id: "provider-setup-required" }
          );
          goToLibrary();
        }
      } catch (error) {
        console.error('Failed to revalidate provider configuration:', error);
        if (!cancelled && isBackendConnectionError(error)) {
          notify.error(
            "Cannot reach backend",
            error.message,
            { id: "backend-unreachable" }
          );
        } else if (!cancelled && selectedProvider === 'presenton') {
          notify.error(
            "Could not verify the model provider",
            "Your current page has been kept open. Try again after checking the backend service.",
            { id: "presenton-status-unavailable" }
          );
        } else if (!cancelled) {
          notify.error(
            "Could not verify provider settings",
            "Your current page has been kept open. Refresh after checking the backend service.",
            { id: "configuration-unavailable" }
          );
        }
      }
    };

    void revalidateProviderConfiguration();
    return () => {
      cancelled = true;
    };
  }, [role, isAdmin, dispatch, isSettingsRoute, route, router]);

  useEffect(() => {
    if (!shouldShowStartupSplash) {
      setHasMetSplashDuration(true);
      return;
    }

    const timeout = window.setTimeout(() => {
      setHasMetSplashDuration(true);
    }, PRESENTON_SPLASH_MIN_DURATION_MS);

    return () => window.clearTimeout(timeout);
  }, [shouldShowStartupSplash]);

  const setLoadingToFalseAfterNavigatingTo = (pathname: string) => {
    if (window.location.pathname === withBasePath(pathname)) {
      setIsLoading(false);
      return;
    }

    const interval = setInterval(() => {
      if (window.location.pathname === withBasePath(pathname)) {
        clearInterval(interval);
        setIsLoading(false);
      }
    }, 500);
  }

  const fetchUserConfigState = async () => {
    if (route.startsWith("/pdf-maker")) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      await assertBackendReachable();
    } catch (error) {
      console.error('Failed to reach the FastAPI backend:', error);
      notify.error(
        "Cannot reach backend",
        error instanceof Error ? error.message : "Check the backend service and try again.",
        { id: "backend-unreachable" }
      );
      setIsLoading(false);
      return;
    }

    let authenticatedRole: "admin" | "user" | null = null;
    try {
      const res = await fetch(getApiUrl('/api/v1/auth/status'), {
        cache: 'no-store', credentials: 'include',
      });
      if (!res.ok) throw new Error(`auth status returned ${res.status}`);
      const data = await res.json();
      if (data.authenticated) {
        authenticatedRole = data.role === 'admin' ? 'admin' : data.role === 'user' ? 'user' : null;
      }
      if (!authenticatedRole) throw new Error('Authenticated role is required');
    } catch (e) {
      console.error('Failed to fetch authenticated role:', e);
      dispatch(setUserRole(null));
      dispatch(setLLMConfig({}));
      notify.error(
        "Could not load configuration",
        "Your current page has been kept open. Refresh after checking the backend service.",
        { id: "configuration-unavailable" }
      );
      setIsLoading(false);
      return;
    }
    dispatch(setUserRole(authenticatedRole));

    if (authenticatedRole === 'admin') {
      let llmConfig: LLMConfig = {};
      try {
        const res = await fetch('/api/user-config');
        if (!res.ok) throw new Error(`user-config returned ${res.status}`);
        llmConfig = await res.json();
      } catch (e) {
        console.error('Failed to fetch user config:', e);
        notify.error(
          "Could not load provider settings",
          "Your current page has been kept open. Refresh after checking the backend service.",
          { id: "configuration-unavailable" }
        );
        setIsLoading(false);
        return;
      }
      llmConfig = normalizeLLMConfig(llmConfig);

      dispatch(setLLMConfig(llmConfig));

      let hasPresentonCloud = false;
      if (llmConfig.LLM === 'presenton') {
        try {
          const response = await fetch(
            getApiUrl('/api/v1/auth/presenton/status'),
            { cache: 'no-store', credentials: 'include' }
          );
          if (!response.ok) {
            await assertBackendReachable();
            throw new Error(`Presenton status returned ${response.status}`);
          }
          const status = await response.json();
          hasPresentonCloud = Boolean(status.linked);
        } catch (error) {
          console.error('Failed to fetch Presenton cloud status:', error);
          const backendUnavailable = isBackendConnectionError(error);
          notify.error(
            backendUnavailable ? "Cannot reach backend" : "Could not verify the model provider",
            backendUnavailable
              ? error.message
              : "Your current page has been kept open. Refresh after checking the backend service.",
            { id: backendUnavailable ? "backend-unreachable" : "presenton-status-unavailable" }
          );
          setIsLoading(false);
          return;
        }
      }
      const isValid = hasValidLLMConfig(llmConfig) &&
        (llmConfig.LLM !== 'presenton' || hasPresentonCloud);
      if (route.startsWith('/pdf-maker')) {
        setIsLoading(false);
        return;
      }
      if (isValid) {
        // Check if the selected Ollama model is pulled
        if (llmConfig.LLM === 'ollama' && llmConfig.OLLAMA_MODEL) {
          let isAvailable = false;
          try {
            isAvailable = await isOllamaModelAvailable(
              llmConfig.OLLAMA_MODEL,
              llmConfig.OLLAMA_URL
            );
          } catch (error) {
            const backendUnavailable = isBackendConnectionError(error);
            notify.error(
              backendUnavailable ? "Cannot reach backend" : "Could not connect to Ollama",
              error instanceof Error ? error.message : "Check the Ollama URL and try again.",
              { id: backendUnavailable ? "backend-unreachable" : "ollama-unreachable" }
            );
            setIsLoading(false);
            return;
          }
          if (!isAvailable) {
            goToLibrary();
            setLoadingToFalseAfterNavigatingTo('/settings');
            return;
          }
        }
        if (route === '/') {
          goToLibrary();
          setLoadingToFalseAfterNavigatingTo('/upload');
        } else {
          setIsLoading(false);
        }
      } else if (!isSettingsRoute) {
        // Sibyl: no setup wizard. Without a usable provider (normally the
        // OpenRouter key from the environment), send the owner to Settings.
        notify.warning(
          "Model provider needed",
          "Set OPENROUTER_API_KEY for Sibyl, or choose a provider in Settings.",
          { id: "provider-setup-required" }
        );
        goToLibrary();
        setLoadingToFalseAfterNavigatingTo('/settings');
      } else {
        setIsLoading(false);
      }
    } else {
      try {
        const res = await fetch("/api/runtime-config", {
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`runtime-config returned ${res.status}`);
        const runtime = await res.json();
        const runtimeConfig = normalizeLLMConfig(
          (runtime.config || {}) as LLMConfig
        );
        dispatch(setLLMConfig(runtimeConfig));
        if (!runtime.configured) {
          notify.error(
            "Instance not configured",
            "Ask the administrator to configure the AI providers in Settings."
          );
          setIsLoading(false);
          return;
        }
      } catch (error) {
        console.error("Failed to fetch runtime configuration:", error);
        notify.error(
          "Could not load provider settings",
          "Your current page has been kept open. Refresh after checking the backend service.",
          { id: "configuration-unavailable" }
        );
        setIsLoading(false);
        return;
      }
      if (route === '/') {
        goToLibrary();
        setLoadingToFalseAfterNavigatingTo('/upload');
      } else {
        setIsLoading(false);
      }
    }
  }

  if (isLoading || !hasMetSplashDuration) {
    return <ConfigurationLoadingScreen />;
  }

  return children;
}
