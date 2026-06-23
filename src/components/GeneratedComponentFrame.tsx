import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { defaultTheme } from '../shared/defaults';
import type { PageNode, SessionSnapshot, ThemeTokens } from '../shared/types';

type HostCapability = 'sendPrompt' | 'selectSnapshot' | 'exportCanvasPng';

type GeneratedComponentFrameProps = {
  node: PageNode;
  theme: ThemeTokens;
  snapshots: SessionSnapshot[];
  activeSnapshotId: string | null;
  onSendPrompt: (prompt: string) => void;
  onSelectSnapshot: (snapshotId: string) => void;
  onExportCanvas: () => void;
  onError?: (message: string) => void;
};

type SandboxToHostMessage =
  | { type: 'READY'; nodeId: string }
  | { type: 'HEIGHT_CHANGE'; nodeId: string; height: number }
  | { type: 'COMPONENT_ERROR'; nodeId: string; message: string }
  | { type: 'CALL_CAPABILITY'; nodeId: string; capability: HostCapability; args: unknown[] };

function getCapabilities(node: PageNode): HostCapability[] {
  return Array.isArray(node.props.capabilities) ? (node.props.capabilities as HostCapability[]) : [];
}

function getMountProps(node: PageNode): Record<string, unknown> {
  const rawProps = node.props.mountProps;
  return rawProps && typeof rawProps === 'object' && !Array.isArray(rawProps) ? (rawProps as Record<string, unknown>) : {};
}

function getComponentBackgroundImage(mountProps: Record<string, unknown>): string | undefined {
  return typeof mountProps.backgroundImage === 'string' && mountProps.backgroundImage.trim().length > 0
    ? mountProps.backgroundImage
    : undefined;
}

function getInitialFrameHeight(node: PageNode): number {
  const minHeight = node.styleTokens.minHeight;
  if (typeof minHeight === 'number' && Number.isFinite(minHeight)) {
    return Math.max(120, Math.min(2000, minHeight));
  }
  if (typeof minHeight === 'string') {
    const pxMatch = minHeight.trim().match(/^(\d+(?:\.\d+)?)px$/);
    if (pxMatch) {
      return Math.max(120, Math.min(2000, Number(pxMatch[1])));
    }
  }
  return 160;
}

function createSandboxSrcDoc(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body, #root {
        margin: 0;
        min-height: 100%;
        background: transparent;
      }

      body {
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #111;
        overflow: hidden;
      }

      button, input, textarea, select {
        font: inherit;
      }
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script>
      (function () {
        "use strict";

        var current = {
          nodeId: "",
          code: "",
          props: {},
          theme: {},
          system: { snapshots: [], activeSnapshotId: null },
          capabilities: []
        };
        var hookValues = [];
        var hookCleanups = [];
        var hookIndex = 0;
        var effectQueue = [];
        var scheduled = false;
        var root = document.getElementById("root");

        function post(message) {
          parent.postMessage(message, "*");
        }

        function normalizeStyle(style) {
          if (!style || typeof style !== "object") {
            return "";
          }
          return Object.keys(style).map(function (key) {
            var value = style[key];
            if (value === null || value === undefined) {
              return "";
            }
            var cssKey = key.startsWith("--")
              ? key
              : key.replace(/[A-Z]/g, function (letter) { return "-" + letter.toLowerCase(); });
            return cssKey + ":" + String(value);
          }).filter(Boolean).join(";");
        }

        function flattenChildren(input, output) {
          input.forEach(function (item) {
            if (Array.isArray(item)) {
              flattenChildren(item, output);
            } else if (item !== false && item !== true && item !== null && item !== undefined) {
              output.push(item);
            }
          });
          return output;
        }

        function createElement(type, props) {
          var children = flattenChildren(Array.prototype.slice.call(arguments, 2), []);
          return { type: type, props: props || {}, children: children };
        }

        function useState(initialValue) {
          var index = hookIndex;
          hookIndex += 1;
          if (hookValues.length <= index) {
            hookValues[index] = typeof initialValue === "function" ? initialValue() : initialValue;
          }
          return [
            hookValues[index],
            function (nextValue) {
              hookValues[index] = typeof nextValue === "function" ? nextValue(hookValues[index]) : nextValue;
              scheduleRender();
            }
          ];
        }

        function depsChanged(previous, next) {
          if (!previous || !next || previous.length !== next.length) {
            return true;
          }
          for (var index = 0; index < previous.length; index += 1) {
            if (!Object.is(previous[index], next[index])) {
              return true;
            }
          }
          return false;
        }

        function useEffect(callback, deps) {
          var index = hookIndex;
          hookIndex += 1;
          var previous = hookValues[index];
          if (depsChanged(previous, deps)) {
            hookValues[index] = deps;
            effectQueue.push({ index: index, callback: callback });
          }
        }

        function useRef(initialValue) {
          var index = hookIndex;
          hookIndex += 1;
          if (hookValues.length <= index) {
            hookValues[index] = { current: initialValue };
          }
          return hookValues[index];
        }

        function appendRendered(parentNode, value) {
          if (value === null || value === undefined || value === false || value === true) {
            return;
          }
          if (typeof value === "string" || typeof value === "number") {
            parentNode.appendChild(document.createTextNode(String(value)));
            return;
          }
          if (Array.isArray(value)) {
            value.forEach(function (child) { appendRendered(parentNode, child); });
            return;
          }
          if (typeof value.type === "function") {
            appendRendered(parentNode, value.type(Object.assign({}, value.props, { children: value.children })));
            return;
          }

          var element = document.createElement(String(value.type || "div"));
          var props = value.props || {};
          Object.keys(props).forEach(function (key) {
            var propValue = props[key];
            if (key === "children" || propValue === null || propValue === undefined || propValue === false) {
              return;
            }
            if (key === "className") {
              element.setAttribute("class", String(propValue));
              return;
            }
            if (key === "style") {
              element.setAttribute("style", normalizeStyle(propValue));
              return;
            }
            if (key.slice(0, 2) === "on" && typeof propValue === "function") {
              element.addEventListener(key.slice(2).toLowerCase(), function (event) {
                try {
                  propValue(event);
                } catch (error) {
                  reportError(error);
                }
              });
              return;
            }
            if (propValue === true) {
              element.setAttribute(key, "");
              return;
            }
            element.setAttribute(key === "htmlFor" ? "for" : key, String(propValue));
          });
          value.children.forEach(function (child) { appendRendered(element, child); });
          parentNode.appendChild(element);
        }

        function reportHeight() {
          var height = Math.max(120, root.scrollHeight, document.body.scrollHeight, document.documentElement.scrollHeight);
          post({ type: "HEIGHT_CHANGE", nodeId: current.nodeId, height: height });
        }

        function reportError(error) {
          var message = error && error.message ? error.message : String(error || "Generated component failed");
          post({ type: "COMPONENT_ERROR", nodeId: current.nodeId, message: message });
        }

        function assertRenderable(value) {
          if (value === null || value === undefined || value === false || value === true) {
            throw new Error("Generated component must return a React element or renderable value at top level.");
          }
          if (Array.isArray(value) && value.length === 0) {
            throw new Error("Generated component returned an empty array. Return a visible React element at top level.");
          }
          if (typeof value === "object" && !Array.isArray(value) && typeof value.type !== "string" && typeof value.type !== "function") {
            throw new Error("Generated component returned an invalid React element. Return React.createElement(...) at top level.");
          }
        }

        function runEffects() {
          var queued = effectQueue;
          effectQueue = [];
          queued.forEach(function (effect) {
            try {
              if (typeof hookCleanups[effect.index] === "function") {
                hookCleanups[effect.index]();
              }
              var cleanup = effect.callback();
              hookCleanups[effect.index] = typeof cleanup === "function" ? cleanup : undefined;
            } catch (error) {
              reportError(error);
            }
          });
        }

        function render() {
          try {
            hookIndex = 0;
            var sdk = {
              sendPrompt: function (text) {
                post({ type: "CALL_CAPABILITY", nodeId: current.nodeId, capability: "sendPrompt", args: [String(text || "")] });
              },
              selectSnapshot: function (snapshotId) {
                post({ type: "CALL_CAPABILITY", nodeId: current.nodeId, capability: "selectSnapshot", args: [String(snapshotId || "")] });
              },
              exportCanvasPng: function () {
                post({ type: "CALL_CAPABILITY", nodeId: current.nodeId, capability: "exportCanvasPng", args: [] });
              }
            };
            var ReactRuntime = {
              createElement: createElement,
              useState: useState,
              useEffect: useEffect,
              useMemo: function (factory) {
                return typeof factory === "function" ? factory() : undefined;
              },
              useCallback: function (callback) {
                return callback;
              },
              useRef: useRef
            };
            var factory = new Function(
              "React",
              "props",
              "theme",
              "system",
              "sdk",
              "createElement",
              "useState",
              "useEffect",
              "useMemo",
              "useCallback",
              "useRef",
              '"use strict";\\n' + current.code
            );
            var tree = factory(
              ReactRuntime,
              current.props,
              current.theme,
              current.system,
              sdk,
              createElement,
              useState,
              useEffect,
              ReactRuntime.useMemo,
              ReactRuntime.useCallback,
              useRef
            );
            assertRenderable(tree);
            root.replaceChildren();
            appendRendered(root, tree);
            runEffects();
            reportHeight();
          } catch (error) {
            root.replaceChildren();
            reportError(error);
          }
        }

        function scheduleRender() {
          if (scheduled) {
            return;
          }
          scheduled = true;
          setTimeout(function () {
            scheduled = false;
            render();
          }, 0);
        }

        window.addEventListener("message", function (event) {
          var message = event.data || {};
          if (message.type === "INIT_COMPONENT" || message.type === "UPDATE_COMPONENT") {
            current = {
              nodeId: String(message.nodeId || ""),
              code: String(message.code || ""),
              props: message.mountProps && typeof message.mountProps === "object" ? message.mountProps : {},
              theme: message.theme && typeof message.theme === "object" ? message.theme : {},
              system: {
                snapshots: Array.isArray(message.snapshots) ? message.snapshots : [],
                activeSnapshotId: message.activeSnapshotId || null
              },
              capabilities: Array.isArray(message.capabilities) ? message.capabilities : []
            };
            render();
          }
          if (message.type === "DISPOSE_COMPONENT") {
            hookCleanups.forEach(function (cleanup) {
              if (typeof cleanup === "function") {
                cleanup();
              }
            });
            hookCleanups = [];
            hookValues = [];
            root.replaceChildren();
          }
        });

        post({ type: "READY", nodeId: "" });
      })();
    </script>
  </body>
</html>`;
}

export function GeneratedComponentFrame({
  activeSnapshotId,
  node,
  onError,
  onExportCanvas,
  onSelectSnapshot,
  onSendPrompt,
  snapshots,
  theme,
}: GeneratedComponentFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [frameHeight, setFrameHeight] = useState(() => getInitialFrameHeight(node));
  const code = String(node.props.code ?? '');
  const name = String(node.props.name ?? node.id);
  const capabilities = useMemo(() => getCapabilities(node), [node]);
  const mountProps = useMemo(() => getMountProps(node), [node]);
  const runtimeTheme = useMemo(() => ({ ...defaultTheme, ...theme }), [theme]);
  const backgroundImage = getComponentBackgroundImage(mountProps);
  const frameStyle = useMemo(() => {
    const style: CSSProperties = { minHeight: frameHeight };
    if (!backgroundImage) {
      return style;
    }
    return {
      ...style,
      backgroundImage: `linear-gradient(rgba(255,255,255,0.54), rgba(255,255,255,0.66)), url(${backgroundImage})`,
      backgroundPosition: 'center',
      backgroundSize: 'cover',
    };
  }, [backgroundImage, frameHeight]);
  const srcDoc = useMemo(() => createSandboxSrcDoc(), []);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);

  useEffect(() => {
    setRuntimeError(null);
    setFrameHeight(getInitialFrameHeight(node));
  }, [code, node.id, node.styleTokens.minHeight]);

  useEffect(() => {
    function postComponentUpdate(type: 'INIT_COMPONENT' | 'UPDATE_COMPONENT') {
      iframeRef.current?.contentWindow?.postMessage(
        {
          type,
          nodeId: node.id,
          code,
          mountProps,
          theme: runtimeTheme,
          snapshots,
          activeSnapshotId,
          capabilities,
        },
        '*',
      );
    }

    function handleMessage(event: MessageEvent<SandboxToHostMessage>) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }

      const message = event.data;
      if (!message || typeof message !== 'object') {
        return;
      }

      if (message.type === 'READY') {
        postComponentUpdate('INIT_COMPONENT');
        return;
      }

      if (message.nodeId !== node.id) {
        return;
      }

      if (message.type === 'HEIGHT_CHANGE') {
        if (Number.isFinite(message.height)) {
          setFrameHeight(Math.max(120, Math.min(2000, Number(message.height))));
        }
        return;
      }

      if (message.type === 'COMPONENT_ERROR') {
        const errorMessage = message.message || 'Generated component failed';
        setRuntimeError(errorMessage);
        onError?.(errorMessage);
        return;
      }

      if (message.type === 'CALL_CAPABILITY') {
        const allowed = new Set(capabilities);
        if (!allowed.has(message.capability)) {
          onError?.(`Capability not declared: ${message.capability}`);
          return;
        }
        const args = Array.isArray(message.args) ? message.args : [];
        if (message.capability === 'sendPrompt') {
          const prompt = typeof args[0] === 'string' ? args[0].trim() : '';
          if (!prompt) {
            onError?.('Generated component sent an empty prompt');
            return;
          }
          onSendPrompt(prompt);
          return;
        }
        if (message.capability === 'selectSnapshot') {
          const snapshotId = typeof args[0] === 'string' ? args[0] : '';
          if (!snapshots.some((snapshot) => snapshot.id === snapshotId)) {
            onError?.('Generated component selected an unknown snapshot');
            return;
          }
          onSelectSnapshot(snapshotId);
          return;
        }
        if (message.capability === 'exportCanvasPng') {
          if (args.length > 0) {
            onError?.('Generated component sent invalid export arguments');
            return;
          }
          onExportCanvas();
        }
      }
    }

    window.addEventListener('message', handleMessage);
    postComponentUpdate('UPDATE_COMPONENT');
    return () => {
      iframeRef.current?.contentWindow?.postMessage({ type: 'DISPOSE_COMPONENT', nodeId: node.id }, '*');
      window.removeEventListener('message', handleMessage);
    };
  }, [activeSnapshotId, capabilities, code, mountProps, node.id, onError, onExportCanvas, onSelectSnapshot, onSendPrompt, runtimeTheme, snapshots]);

  return (
    <div
      className={['generated-component-frame', backgroundImage ? 'generated-component-frame--background' : ''].filter(Boolean).join(' ')}
      role="group"
      aria-label={name}
      style={frameStyle}
    >
      <iframe
        aria-label={name}
        className="generated-component-frame__iframe"
        ref={iframeRef}
        sandbox="allow-scripts"
        srcDoc={srcDoc}
        style={{ height: frameHeight }}
        title={name}
      />
      {runtimeError ? (
        <div className="generated-component-frame__error" role="alert">
          <strong>组件渲染失败</strong>
          <span>{runtimeError}</span>
        </div>
      ) : null}
    </div>
  );
}
