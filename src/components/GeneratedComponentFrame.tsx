import React, { useEffect, useMemo, useState } from 'react';
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

type GeneratedFactory = (
  ReactRuntime: typeof React,
  props: Record<string, unknown>,
  theme: ThemeTokens,
  system: { snapshots: SessionSnapshot[]; activeSnapshotId: string | null },
  sdk: {
    sendPrompt: (text: string) => void;
    selectSnapshot: (snapshotId: string) => void;
    exportCanvasPng: () => void;
  },
) => React.ReactNode;

function getCapabilities(node: PageNode): HostCapability[] {
  return Array.isArray(node.props.capabilities) ? (node.props.capabilities as HostCapability[]) : [];
}

function GeneratedComponentError({ message, onError }: { message: string; onError?: (message: string) => void }) {
  useEffect(() => {
    onError?.(message);
  }, [message, onError]);

  return null;
}

function GeneratedComponentBody({
  activeSnapshotId,
  factory,
  onError,
  props,
  sdk,
  snapshots,
  theme,
}: {
  activeSnapshotId: string | null;
  factory: GeneratedFactory;
  onError?: (message: string) => void;
  props: Record<string, unknown>;
  sdk: Parameters<GeneratedFactory>[4];
  snapshots: SessionSnapshot[];
  theme: ThemeTokens;
}) {
  try {
    return factory(
      React,
      props,
      theme,
      {
        snapshots,
        activeSnapshotId,
      },
      sdk,
    );
  } catch (error) {
    return <GeneratedComponentError message={error instanceof Error ? error.message : 'Generated component failed'} onError={onError} />;
  }
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
  const [frameHeight, setFrameHeight] = useState(280);
  const code = String(node.props.code ?? '');
  const capabilities = useMemo(() => getCapabilities(node), [node]);
  const props = useMemo(() => {
    const rawProps = node.props.mountProps;
    return rawProps && typeof rawProps === 'object' ? rawProps : {};
  }, [node.props.mountProps]);

  const sdk = useMemo(() => {
    const allowed = new Set(capabilities);
    return {
      sendPrompt(text: string) {
        if (!allowed.has('sendPrompt')) {
          throw new Error('Capability not declared: sendPrompt');
        }
        onSendPrompt(String(text || ''));
      },
      selectSnapshot(snapshotId: string) {
        if (!allowed.has('selectSnapshot')) {
          throw new Error('Capability not declared: selectSnapshot');
        }
        onSelectSnapshot(String(snapshotId || ''));
      },
      exportCanvasPng() {
        if (!allowed.has('exportCanvasPng')) {
          throw new Error('Capability not declared: exportCanvasPng');
        }
        onExportCanvas();
      },
    };
  }, [capabilities, onExportCanvas, onSelectSnapshot, onSendPrompt]);

  const factory = useMemo(() => {
    try {
      return new Function('React', 'props', 'theme', 'system', 'sdk', `"use strict";\n${code}`) as GeneratedFactory;
    } catch (error) {
      onError?.(error instanceof Error ? error.message : 'Generated component failed to compile');
      return null;
    }
  }, [code, onError]);

  useEffect(() => {
    setFrameHeight(360);
  }, [factory]);

  return (
    <div className="generated-component-frame" style={{ minHeight: frameHeight }} role="group" aria-label={String(node.props.name ?? node.id)}>
      {factory ? (
        <GeneratedComponentBody
          activeSnapshotId={activeSnapshotId}
          factory={factory}
          onError={onError}
          props={props}
          sdk={sdk}
          snapshots={snapshots}
          theme={theme}
        />
      ) : null}
    </div>
  );
}
