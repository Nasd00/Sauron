import assert from 'node:assert/strict';
import test from 'node:test';
import { globeZoomPitchLimit, installGlobeZoomGuard, MAX_GLOBE_ZOOM_DISTANCE } from '../reference/src/app/globeZoom.js';

function eventSource() {
  const listeners = new Set<() => void>();
  return {
    addEventListener(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    emit() { for (const listener of listeners) listener(); },
    get size() { return listeners.size; },
  };
}
function fixture(maximum = Infinity) {
  const handlers = new Map<string, (event: any) => void>();
  const frame = eventSource(), moveEnd = eventSource();
  const views: any[] = [];
  const viewer = {
    trackedEntity: undefined as unknown,
    container: {
      addEventListener(name: string, handler: (event: any) => void) { handlers.set(name, handler); },
      removeEventListener(name: string) { handlers.delete(name); },
    },
    camera: {
      positionCartographic: { height: 600 }, pitch: -Math.PI / 6, heading: .2, roll: 0, moveEnd,
      setView(view: any) { views.push(view); this.pitch = view.orientation.pitch; },
    },
    scene: { preUpdate: frame, screenSpaceCameraController: { maximumZoomDistance: maximum } },
  };
  return { viewer, handlers, frame, moveEnd, views };
}

test('zoom transition preserves city views and eases monotonically to a globe view', () => {
  for (const height of [600, 25_000, 500_000, NaN, Infinity]) assert.equal(globeZoomPitchLimit(height), null);
  const heights = [500_001, 1_000_000, 2_000_000, 4_000_000, 5_000_000, 18_000_000];
  const pitches = heights.map(height => globeZoomPitchLimit(height)!);
  for (let i = 1; i < pitches.length; i++) assert.ok(pitches[i] <= pitches[i - 1]);
  assert.equal(pitches.at(-1), -Math.PI / 2);
  assert.ok(Math.abs(pitches[0] + Math.PI / 6) < 1e-8);
});

test('outward scroll keeps Earth in view without touching nearby, inward, or tracked navigation', () => {
  const f = fixture();
  const dispose = installGlobeZoomGuard(f.viewer);
  assert.equal(f.viewer.scene.screenSpaceCameraController.maximumZoomDistance, MAX_GLOBE_ZOOM_DISTANCE);
  f.handlers.get('wheel')!({ deltaY: 100 });
  f.frame.emit();
  assert.equal(f.views.length, 0);
  f.viewer.camera.positionCartographic.height = 6_000_000;
  f.frame.emit();
  assert.equal(f.views.length, 1);
  assert.deepEqual(f.views[0].orientation, { heading: .2, pitch: -Math.PI / 2, roll: 0 });
  assert.equal(f.viewer.camera.positionCartographic.height, 6_000_000);
  f.viewer.camera.pitch = -Math.PI / 6;
  f.handlers.get('wheel')!({ deltaY: -100 });
  f.frame.emit();
  assert.equal(f.views.length, 1);
  f.handlers.get('wheel')!({ deltaY: 100 });
  f.viewer.trackedEntity = {};
  f.frame.emit();
  assert.equal(f.views.length, 1);
  f.viewer.trackedEntity = undefined;
  f.moveEnd.emit();
  f.frame.emit();
  assert.equal(f.views.length, 1);
  dispose(); dispose();
  assert.equal(f.frame.size, 0);
  assert.equal(f.moveEnd.size, 0);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.viewer.scene.screenSpaceCameraController.maximumZoomDistance, Infinity);
});

test('touch pinch-out follows the same guard and retains stricter existing limits', () => {
  const f = fixture(10_000_000);
  const dispose = installGlobeZoomGuard(f.viewer);
  f.viewer.camera.positionCartographic.height = 6_000_000;
  const touch = (distance: number) => ({ touches: [{ clientX: 0, clientY: 0 }, { clientX: distance, clientY: 0 }] });
  f.handlers.get('touchmove')!(touch(100));
  f.frame.emit();
  assert.equal(f.views.length, 0);
  f.handlers.get('touchmove')!(touch(80));
  f.frame.emit();
  assert.equal(f.views.length, 1);
  assert.equal(f.viewer.scene.screenSpaceCameraController.maximumZoomDistance, 10_000_000);
  dispose();
  assert.equal(f.viewer.scene.screenSpaceCameraController.maximumZoomDistance, 10_000_000);
});
