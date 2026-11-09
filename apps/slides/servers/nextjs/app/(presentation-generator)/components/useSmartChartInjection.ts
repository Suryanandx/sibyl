"use client";

import { useEffect, type RefObject } from "react";

import { loadChartBrowserRuntime } from "@/lib/chart-browser";

export function useSmartChartInjection({
  html,
  instanceId,
  domRevision,
  containerRef,
}: {
  html: string;
  instanceId: string;
  domRevision?: string | number;
  containerRef: RefObject<HTMLDivElement | null>;
}) {
  useEffect(() => {
    let cancelled = false;
    let paintFrame: number | undefined;
    let destroyRenderedCharts: (() => void) | undefined;

    const renderCharts = async () => {
      const container = containerRef.current;
      if (!container || !html) return;

      try {
        const { Chart } = await loadChartBrowserRuntime();
        if (cancelled) return;

        destroyRenderedCharts = () => {
          container.querySelectorAll<HTMLCanvasElement>("canvas").forEach((canvas) => {
            Chart.getChart(canvas)?.destroy();
          });
        };
        destroyRenderedCharts();
        document
          .querySelectorAll(`script[data-smart-chart-instance="${instanceId}"]`)
          .forEach((script) => script.remove());

        const rootId = JSON.stringify(instanceId);
        const sourceDocument = new DOMParser().parseFromString(html, "text/html");
        sourceDocument.querySelectorAll<HTMLScriptElement>("script").forEach((source) => {
          const sourceCode = source.textContent?.trim();
          if (!sourceCode) return;

          const script = document.createElement("script");
          script.dataset.smartChartInstance = instanceId;
          script.textContent = `
            try {
              (function () {
                var rootId = ${rootId};
                var root = Array.from(document.querySelectorAll('[data-smart-slide-instance]'))
                  .find(function (element) {
                    return element.getAttribute('data-smart-slide-instance') === rootId;
                  });
                if (!root) return;
                var realDocument = document;
                var scopedDocument = Object.create(realDocument);
                scopedDocument.querySelector = root.querySelector.bind(root);
                scopedDocument.querySelectorAll = root.querySelectorAll.bind(root);
                scopedDocument.getElementById = function (id) {
                  try {
                    var escapedId = window.CSS && CSS.escape
                      ? CSS.escape(id)
                      : String(id).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
                    return root.querySelector('#' + escapedId);
                  } catch (_) {
                    return null;
                  }
                };
                scopedDocument.getElementsByClassName = root.getElementsByClassName.bind(root);
                scopedDocument.getElementsByTagName = root.getElementsByTagName.bind(root);
                scopedDocument.addEventListener = function (type, listener, options) {
                  if (type === 'DOMContentLoaded' && typeof listener === 'function') {
                    queueMicrotask(function () {
                      listener.call(realDocument, new Event('DOMContentLoaded'));
                    });
                    return;
                  }
                  return realDocument.addEventListener(type, listener, options);
                };
                scopedDocument.removeEventListener = realDocument.removeEventListener.bind(realDocument);
                Object.defineProperty(scopedDocument, 'readyState', {
                  configurable: true,
                  get: function () { return 'complete'; }
                });
                Object.defineProperty(scopedDocument, 'body', {
                  configurable: true,
                  get: function () { return root; }
                });
                (function (document, Chart, ChartDataLabels) {
                  ${sourceCode}
                })(scopedDocument, window.Chart, window.ChartDataLabels);
              })();
            } catch (error) {
              console.error('Smart slide chart failed to render', error);
            }
          `;
          document.body.appendChild(script);
        });

        paintFrame = window.requestAnimationFrame(() => {
          if (cancelled) return;
          container.querySelectorAll<HTMLCanvasElement>("canvas").forEach((canvas) => {
            const chart = Chart.getChart(canvas);
            if (!chart) return;
            chart.update("none");
            canvas.dataset.presentonChartRendered = "true";
          });
        });
      } catch (error) {
        console.error("Could not initialize Smart slide charts", error);
      }
    };

    void renderCharts();

    return () => {
      cancelled = true;
      if (paintFrame !== undefined) window.cancelAnimationFrame(paintFrame);
      destroyRenderedCharts?.();
      document
        .querySelectorAll(`script[data-smart-chart-instance="${instanceId}"]`)
        .forEach((script) => script.remove());
    };
  }, [containerRef, domRevision, html, instanceId]);
}
