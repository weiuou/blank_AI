import { createElement, type CSSProperties, type ElementType } from 'react';
import { GeneratedComponentFrame } from './GeneratedComponentFrame';
import type { PageNode, PageState, SessionSnapshot } from '../shared/types';

type PageRendererProps = {
  activeSnapshotId: string | null;
  onExportCanvas: () => void;
  onGeneratedComponentError?: (message: string) => void;
  onSelectSnapshot: (snapshotId: string) => void;
  onSendPrompt: (prompt: string) => void;
  pageState: PageState;
  snapshots: SessionSnapshot[];
};

function nodeStyleToCss(styleTokens: PageNode['styleTokens']): CSSProperties {
  function cssKeyToReactKey(key: string): string {
    if (key.startsWith('--')) {
      return key;
    }
    return key
      .replace(/^-webkit-/, 'Webkit-')
      .replace(/^-moz-/, 'Moz-')
      .replace(/^-ms-/, 'ms-')
      .replace(/^-o-/, 'O-')
      .replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  }

  const css = Object.fromEntries(
    Object.entries(styleTokens).map(([key, value]) => [cssKeyToReactKey(key), value]),
  ) as CSSProperties;
  if (styleTokens.radius) {
    css.borderRadius = styleTokens.radius;
  }
  if (styleTokens.shadow) {
    css.boxShadow = String(styleTokens.shadow);
  }
  if (styleTokens.align) {
    css.textAlign = String(styleTokens.align) as CSSProperties['textAlign'];
  }
  return css;
}

type RenderContext = Omit<PageRendererProps, 'pageState'> & {
  theme: PageState['theme'];
};

function renderChildren(node: PageNode, context: RenderContext) {
  return node.children.map((child) => <RenderedNode context={context} key={child.id} node={child} />);
}

function RenderedNode({ context, node }: { context: RenderContext; node: PageNode }) {
  const style = nodeStyleToCss(node.styleTokens);

  switch (node.type) {
    case 'system_prompt':
    case 'system_timeline':
      return null;
    case 'section':
      return <section style={style}>{renderChildren(node, context)}</section>;
    case 'heading': {
      const level = Number(node.props.level ?? 2);
      const safeLevel = Math.min(4, Math.max(1, level));
      const Tag = `h${safeLevel}` as ElementType;
      return createElement(Tag, { style }, String(node.props.text ?? ''));
    }
    case 'text':
      return <p style={style}>{String(node.props.text ?? '')}</p>;
    case 'button':
    case 'modal_trigger':
      return (
        <button
          className="render-button"
          onClick={() => node.props.action === 'exportCanvasPng' && context.onExportCanvas()}
          style={style}
          type="button"
        >
          {String(node.props.label ?? 'Action')}
        </button>
      );
    case 'input':
      return (
        <label className="render-input" style={style}>
          {node.props.label ? <span>{String(node.props.label)}</span> : null}
          <input placeholder={String(node.props.placeholder ?? '')} readOnly value={String(node.props.value ?? '')} />
        </label>
      );
    case 'card':
      return (
        <article className="render-card" style={style}>
          {node.props.title ? <h3>{String(node.props.title)}</h3> : null}
          {node.props.subtitle ? <p>{String(node.props.subtitle)}</p> : null}
          {renderChildren(node, context)}
        </article>
      );
    case 'list': {
      const items = Array.isArray(node.props.items) ? (node.props.items as string[]) : [];
      const ordered = Boolean(node.props.ordered);
      const ListTag = ordered ? 'ol' : 'ul';
      return (
        <ListTag className="render-list" style={style}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
          {renderChildren(node, context)}
        </ListTag>
      );
    }
    case 'image':
      return <img alt={String(node.props.alt ?? '')} className="render-image" src={String(node.props.src ?? '')} style={style} />;
    case 'image_background':
      return (
        <img
          alt={String(node.props.alt ?? '')}
          aria-hidden="true"
          className="render-image-background"
          src={String(node.props.src ?? '')}
          style={style}
        />
      );
    case 'graffiti_word':
      return (
        <div className="render-graffiti" style={style} aria-hidden="true">
          <span>{String(node.props.text ?? '')}</span>
          <i className="render-graffiti__spray render-graffiti__spray--one" />
          <i className="render-graffiti__spray render-graffiti__spray--two" />
          <i className="render-graffiti__spray render-graffiti__spray--three" />
        </div>
      );
    case 'columns':
      return (
        <div
          className="render-columns"
          style={{
            ...style,
            display: 'grid',
            gridTemplateColumns: `repeat(${Number(node.props.columns ?? 2)}, minmax(0, 1fr))`,
          }}
        >
          {renderChildren(node, context)}
        </div>
      );
    case 'tabs':
    case 'accordion':
    case 'stepper': {
      const items = Array.isArray(node.props.items) ? (node.props.items as string[]) : [];
      return (
        <div className={`render-behavior render-behavior--${node.type}`} style={style}>
          {items.map((item, index) => (
            <div className="render-behavior__item" key={`${item}-${index}`}>
              <span>{item}</span>
            </div>
          ))}
        </div>
      );
    }
    case 'generated_react_component':
      return (
        <div
          className="generated-component-shell"
          style={{
            ...style,
          }}
        >
          <GeneratedComponentFrame
            activeSnapshotId={context.activeSnapshotId}
            node={node}
            onError={context.onGeneratedComponentError}
            onExportCanvas={context.onExportCanvas}
            onSelectSnapshot={context.onSelectSnapshot}
            onSendPrompt={context.onSendPrompt}
            snapshots={context.snapshots}
            theme={context.theme}
          />
        </div>
      );
    default:
      return null;
  }
}

export function PageRenderer({
  activeSnapshotId,
  onExportCanvas,
  onGeneratedComponentError,
  onSelectSnapshot,
  onSendPrompt,
  pageState,
  snapshots,
}: PageRendererProps) {
  const rootStyle: CSSProperties = {
    color: pageState.theme.textPrimary,
    fontFamily: pageState.theme.fontFamily,
    minHeight: '100vh',
  };

  return (
    <div className="page-renderer" style={rootStyle}>
      {pageState.root.children.map((child: PageNode) => (
        <RenderedNode
          context={{
            activeSnapshotId,
            onExportCanvas,
            onGeneratedComponentError,
            onSelectSnapshot,
            onSendPrompt,
            snapshots,
            theme: pageState.theme,
          }}
          key={child.id}
          node={child}
        />
      ))}
    </div>
  );
}
