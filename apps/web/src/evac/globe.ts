import {
  Cartesian2,
  Cartesian3,
  Color,
  Credit,
  EllipsoidTerrainProvider,
  ImageryLayer,
  Ion,
  LabelStyle,
  UrlTemplateImageryProvider,
  VerticalOrigin,
  Viewer,
} from "cesium";

export const demoCamera = {
  id: "demo-camera-001",
  name: "Ann Arbor demo replay",
  latitude: 42.2808,
  longitude: -83.743,
} as const;

/** CARTO's dark basemap over OpenStreetMap data keeps hazard overlays readable. No key required. */
function darkBasemap(): ImageryLayer {
  return new ImageryLayer(new UrlTemplateImageryProvider({
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    subdomains: ["a", "b", "c", "d"],
    maximumLevel: 19,
    credit: new Credit("© OpenStreetMap contributors © CARTO", true),
  }));
}

export function createGlobe(container: HTMLElement): Viewer {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
  if (token) Ion.defaultAccessToken = token;
  const viewer = new Viewer(container, {
    animation: false,
    baseLayer: darkBasemap(),
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    selectionIndicator: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    timeline: false,
  });
  viewer.scene.globe.baseColor = Color.fromCssColorString("#0b1118");
  viewer.scene.backgroundColor = Color.fromCssColorString("#05090d");
  viewer.scene.globe.showGroundAtmosphere = true;
  viewer.scene.fog.enabled = true;

  // God's Eye camera feeding the incident pipeline.
  viewer.entities.add({
    id: demoCamera.id,
    name: demoCamera.name,
    position: Cartesian3.fromDegrees(demoCamera.longitude, demoCamera.latitude),
    point: {
      color: Color.fromCssColorString("#ff8a3d"),
      outlineColor: Color.fromCssColorString("#071018"),
      outlineWidth: 3,
      pixelSize: 11,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      backgroundColor: Color.fromCssColorString("#071018").withAlpha(0.8),
      fillColor: Color.fromCssColorString("#ffc29a"),
      font: "600 11px Inter, system-ui, sans-serif",
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      pixelOffset: new Cartesian2(0, -16),
      showBackground: true,
      style: LabelStyle.FILL_AND_OUTLINE,
      text: `God's Eye cam · ${demoCamera.id}`,
      verticalOrigin: VerticalOrigin.BOTTOM,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
  return viewer;
}
