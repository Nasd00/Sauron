import {
  Cartesian2,
  Cartesian3,
  Color,
  EllipsoidTerrainProvider,
  HeightReference,
  ImageryLayer,
  Ion,
  LabelStyle,
  OpenStreetMapImageryProvider,
  VerticalOrigin,
  Viewer,
} from "cesium";

export const demoCamera = {
  id: "demo-camera-001",
  name: "Ann Arbor demo replay",
  latitude: 42.2808,
  longitude: -83.743,
} as const;

export function createGlobe(container: HTMLElement): Viewer {
  const token = import.meta.env.VITE_CESIUM_ION_TOKEN?.trim();
  if (token) Ion.defaultAccessToken = token;

  const viewer = new Viewer(container, {
    animation: false,
    baseLayer: new ImageryLayer(new OpenStreetMapImageryProvider({
      url: "https://tile.openstreetmap.org/",
    })),
    baseLayerPicker: false,
    fullscreenButton: false,
    geocoder: false,
    infoBox: false,
    navigationHelpButton: false,
    sceneModePicker: true,
    selectionIndicator: false,
    terrainProvider: new EllipsoidTerrainProvider(),
    timeline: false,
  });

  viewer.scene.globe.baseColor = Color.fromCssColorString("#111c26");
  viewer.scene.backgroundColor = Color.fromCssColorString("#071018");
  viewer.scene.globe.showGroundAtmosphere = true;

  viewer.entities.add({
    id: demoCamera.id,
    name: demoCamera.name,
    position: Cartesian3.fromDegrees(demoCamera.longitude, demoCamera.latitude),
    point: {
      color: Color.fromCssColorString("#ff654d"),
      heightReference: HeightReference.CLAMP_TO_GROUND,
      outlineColor: Color.WHITE.withAlpha(0.9),
      outlineWidth: 3,
      pixelSize: 15,
    },
    label: {
      backgroundColor: Color.fromCssColorString("#071018").withAlpha(0.86),
      fillColor: Color.WHITE,
      font: "600 14px system-ui",
      outlineColor: Color.BLACK,
      outlineWidth: 2,
      pixelOffset: new Cartesian2(0, -28),
      showBackground: true,
      style: LabelStyle.FILL_AND_OUTLINE,
      text: demoCamera.id,
      verticalOrigin: VerticalOrigin.BOTTOM,
    },
  });

  viewer.camera.flyTo({
    destination: Cartesian3.fromDegrees(
      demoCamera.longitude,
      demoCamera.latitude,
      1_250_000,
    ),
    duration: 0,
  });

  return viewer;
}
