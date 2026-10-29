/**
 * TODO / DOING / DONE marker helpers.
 * Core cycling lives in treeOps.cycleMarker; this module adds the marker →
 * CSS class mapping used by the renderer and slash-menu application.
 */

import type { Block, Marker } from '../types';
import { cycleMarker as cycle } from '../core/treeOps';

export function cycleMarker(b: Block): Marker {
  return cycle(b);
}

export function setMarker(b: Block, m: Marker): void {
  b.marker = m;
}

export function markerClass(b: Block): string {
  return b.marker ? 'block-marker ' + b.marker.toLowerCase() : '';
}
