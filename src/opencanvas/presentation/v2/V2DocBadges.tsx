import { useCallback, useEffect, useMemo, useState, type RefObject } from 'react';
import { IconFileText } from '@tabler/icons-react';
import { placedElementId } from '../../../dsl/model/model';
import type { CanvasCamera } from '../../domain/camera/types';
import type { Point2d } from '../../domain/geometry/types';
import type { ScenePage } from '../../domain/document/types';
import { buildNodeWorldMatrices, nodeWorldBounds } from '../../domain/scene/worldGeometry';
import type { PixiRendererHost } from '../../infrastructure/pixi/PixiRendererHost';
import { Icon } from '../design-system';
import { Anchored, PlacementContext } from './V2CommentPin';
import { Placement } from './v2CommentPlacement';

const placementFor = (cameraRef: RefObject<CanvasCamera>, hostRef: RefObject<PixiRendererHost | null>): Placement =>
  new Placement(() => cameraRef.current, () => hostRef.current?.getViewportSize() ?? { width: 0, height: 0 }, () => null);

export interface DocBadge { readonly nodeId: string; readonly elementId: string; readonly name: string; readonly world: Point2d }

/** One badge per drawn element that has documentation, at the node's top-right corner in world space. */
export function docBadges(page: ScenePage, documented: ReadonlySet<string>): DocBadge[] {
  if (documented.size === 0) return [];
  const matrices = buildNodeWorldMatrices(page);
  return page.nodes.flatMap((node) => {
    const elementId = placedElementId(node);
    const matrix = matrices.get(node.id);
    if (!elementId || !matrix || !documented.has(elementId)) return [];
    const bounds = nodeWorldBounds(node, matrix);
    const name = typeof node.content.label === 'string' ? node.content.label : elementId;
    return [{ nodeId: node.id, elementId, name, world: { x: bounds.x + bounds.width, y: bounds.y } }];
  });
}

/**
 * A small document button on every element that has documentation: the notes stay off the drawing, the badge says they
 * exist, and a click opens them in the model panel. Rides the comment pins' placement (one layer the camera pans).
 */
export function V2DocBadges(props: {
  readonly page: ScenePage;
  readonly documented: ReadonlySet<string>;
  readonly hostRef: RefObject<PixiRendererHost | null>;
  readonly cameraRef: RefObject<CanvasCamera>;
  readonly subscribeCamera: (listener: () => void) => () => void;
  readonly onOpen: (badge: DocBadge) => void;
}): React.JSX.Element | null {
  const { cameraRef, hostRef, subscribeCamera } = props;
  const [placement] = useState(() => placementFor(cameraRef, hostRef));
  useEffect(() => () => placement.stop(), [placement]);
  useEffect(() => subscribeCamera(() => placement.kick()), [placement, subscribeCamera]);
  const layerRef = useCallback((layer: HTMLElement | null) => placement.setLayer(layer), [placement]);
  const badges = useMemo(() => docBadges(props.page, props.documented), [props.page, props.documented]);
  if (badges.length === 0) return null;
  return (
    <PlacementContext.Provider value={placement}>
      <div className="ofk-comment-layer ofk-doc-layer" ref={layerRef}>
        {badges.map((badge) => (
          <Anchored key={badge.nodeId} world={badge.world} testId="v2-doc-badge">
            <button type="button" className="ofk-doc-badge" aria-label={`Documentation for ${badge.name}`} title="Documentation"
              onPointerDown={(event) => event.stopPropagation()} onClick={() => props.onOpen(badge)}>
              <Icon icon={IconFileText} />
            </button>
          </Anchored>
        ))}
      </div>
    </PlacementContext.Provider>
  );
}
