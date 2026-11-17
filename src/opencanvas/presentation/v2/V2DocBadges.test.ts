import { describe, expect, it } from 'vitest';
import type { SceneNode, ScenePage } from '../../domain/document/types';
import { docBadges } from './V2DocBadges';

const node = (id: string, parentId: string | null, x: number, y: number, elementId?: string): SceneNode => ({
  id, kind: 'rect', parentId, layerId: 'default', zIndex: 0,
  transform: { translation: { x, y }, rotationRadians: 0, scale: { x: 1, y: 1 } },
  size: { width: 100, height: 40 }, content: { label: id }, appearance: {}, ports: [],
  metadata: elementId ? { model: { elementId } } : {}, extensions: {},
} as unknown as SceneNode);

describe('docBadges', () => {
  it('puts one badge on the top-right corner of each documented element, in world space', () => {
    const page = { nodes: [node('shop', null, 10, 20, 'shop'), node('api', 'shop', 5, 5, 'shop.api'), node('note', null, 0, 0)] } as unknown as ScenePage;
    expect(docBadges(page, new Set(['shop.api']))).toEqual([{ nodeId: 'api', elementId: 'shop.api', name: 'api', world: { x: 115, y: 25 } }]);
    expect(docBadges(page, new Set())).toEqual([]);
  });
});
