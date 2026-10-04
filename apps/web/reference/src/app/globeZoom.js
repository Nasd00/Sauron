// Match the existing full-earth preset in locations.js. Close-range navigation,
// photorealistic tiles, terrain, and scope rendering are not changed here.
export const MAX_GLOBE_ZOOM_DISTANCE = 18_000_000;
const TRANSITION_START = 500_000;
const TRANSITION_END = 5_000_000;

/** Maximum pitch during zoom-out: ease from a city tilt to a centered Earth. */
export function globeZoomPitchLimit(height) {
  if (!Number.isFinite(height) || height <= TRANSITION_START) return null;
  const t = Math.min(1, (height - TRANSITION_START) / (TRANSITION_END - TRANSITION_START));
  const eased = t * t * (3 - 2 * t);
  return (-30 - 60 * eased) * Math.PI / 180;
}

/** Keep outward scroll/pinch navigation on Earth without replacing the map. */
export function installGlobeZoomGuard(viewer) {
  const { camera, container } = viewer;
  const interactionHost = container.ownerDocument ?? container;
  const controller = viewer.scene.screenSpaceCameraController;
  const originalMaximum = controller.maximumZoomDistance;
  controller.maximumZoomDistance = Math.min(originalMaximum, MAX_GLOBE_ZOOM_DISTANCE);
  let zoomingOut = false;
  let previousPinchDistance = null;
  const onWheel = (event) => {
    if (Number.isFinite(event.deltaY) && event.deltaY !== 0)
      zoomingOut = event.deltaY > 0;
  };
  const onTouchMove = (event) => {
    if (event.touches.length !== 2) return;
    const [a, b] = event.touches;
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (previousPinchDistance !== null) zoomingOut = distance < previousPinchDistance;
    previousPinchDistance = distance;
  };
  const onTouchEnd = () => { previousPinchDistance = null; };
  const stopZoom = () => { zoomingOut = false; };
  const removeFrameListener = viewer.scene.preUpdate.addEventListener(() => {
    if (!zoomingOut || viewer.trackedEntity) return;
    const pitchLimit = globeZoomPitchLimit(camera.positionCartographic.height);
    if (pitchLimit === null || camera.pitch <= pitchLimit) return;
    camera.setView({
      orientation: { heading: camera.heading, pitch: pitchLimit, roll: camera.roll },
    });
  });
  const removeMoveEndListener = camera.moveEnd.addEventListener(stopZoom);
  container.addEventListener('wheel', onWheel, { capture: true, passive: true });
  container.addEventListener('touchmove', onTouchMove, { capture: true, passive: true });
  container.addEventListener('touchend', onTouchEnd, { passive: true });
  container.addEventListener('touchcancel', onTouchEnd, { passive: true });
  // An explicit drag, button, or keyboard action takes over from wheel inertia.
  interactionHost.addEventListener('pointerdown', stopZoom, { capture: true, passive: true });
  interactionHost.addEventListener('keydown', stopZoom, { capture: true });
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    removeFrameListener();
    removeMoveEndListener();
    container.removeEventListener('wheel', onWheel, true);
    container.removeEventListener('touchmove', onTouchMove, true);
    container.removeEventListener('touchend', onTouchEnd);
    container.removeEventListener('touchcancel', onTouchEnd);
    interactionHost.removeEventListener('pointerdown', stopZoom, true);
    interactionHost.removeEventListener('keydown', stopZoom, true);
    if (controller.maximumZoomDistance === Math.min(originalMaximum, MAX_GLOBE_ZOOM_DISTANCE))
      controller.maximumZoomDistance = originalMaximum;
  };
}
