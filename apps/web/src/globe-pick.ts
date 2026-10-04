import * as Cesium from "cesium";

/** The lon/lat under a screen position: terrain, then scene depth (3D tiles), then the bare ellipsoid. */
export function pickLonLat(viewer: Cesium.Viewer, position: Cesium.Cartesian2): { lon: number; lat: number } | undefined {
  const scene = viewer.scene;
  let cartesian: Cesium.Cartesian3 | undefined;
  // 1) Terrain/globe surface under the cursor (most accurate with a depth buffer).
  const ray = viewer.camera.getPickRay(position);
  if (ray) cartesian = scene.globe.pick(ray, scene) ?? undefined;
  // 2) Scene depth (works over 3D tiles / photorealistic buildings).
  if (!cartesian && scene.pickPositionSupported) {
    cartesian = scene.pickPosition(position) ?? undefined;
  }
  // 3) Ellipsoid intersection — always available, needs no depth buffer, so it
  //    is the reliable fallback (empty-space clicks, headless, globe hidden).
  if (!cartesian) {
    cartesian = viewer.camera.pickEllipsoid(position, scene.globe.ellipsoid) ?? undefined;
  }
  if (!cartesian) return;
  const carto = Cesium.Cartographic.fromCartesian(cartesian);
  if (!carto) return;
  return {
    lon: Cesium.Math.toDegrees(carto.longitude),
    lat: Cesium.Math.toDegrees(carto.latitude),
  };
}
