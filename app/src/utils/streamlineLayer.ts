import type { CustomLayerInterface, Map } from 'mapbox-gl';

type StreamlinePoint = [number, number, number, number];

type StreamlineLine = {
  id: number;
  points: StreamlinePoint[];
};

type StreamlineData = {
  type: 'windStreamlines';
  version: number;
  crs: 'EPSG:4326';
  stats?: {
    speedMin?: number;
    speedMax?: number;
  };
  lines: StreamlineLine[];
};

type StreamlineLayerOptions = {
  id: string;
  dataUrl: string;
  visible: boolean;
  speedRange?: [number, number];
  width?: number;
};

export type StreamlineLayerController = CustomLayerInterface & {
  setVisible: (visible: boolean) => void;
};

const SPEED_COLOR_STOPS = [
  { t: 0, color: [0, 0, 1] as const },
  { t: 0.25, color: [0, 0.5, 1] as const },
  { t: 0.4, color: [0, 1, 1] as const },
  { t: 0.5, color: [1, 1, 0] as const },
  { t: 0.75, color: [1, 0.5, 0] as const },
  { t: 1, color: [1, 0, 0] as const },
] as const;
const DEFAULT_SPEED_RANGE: [number, number] = [0, 8];
const DEFAULT_LINE_WIDTH = 1.0;
const LOW_ZOOM_LINE_WIDTH = 1.41;
const MID_ZOOM_LINE_WIDTH = 1.875;
const HIGH_ZOOM_LINE_WIDTH = 2.85;
const MID_ZOOM_START = 18;
const HIGH_ZOOM_START = 19;
const HIGH_ZOOM_END = 20;
const ADD_BATCH_SIZE = 80;

function clamp01(value: number) {
  return Math.min(1, Math.max(0, value));
}

function lerpColor(from: readonly number[], to: readonly number[], t: number) {
  return [
    from[0] + (to[0] - from[0]) * t,
    from[1] + (to[1] - from[1]) * t,
    from[2] + (to[2] - from[2]) * t,
  ] as const;
}

function colorForSpeed(speed: number, minSpeed: number, maxSpeed: number) {
  const denominator = Math.max(maxSpeed - minSpeed, 1e-6);
  const normalizedSpeed = clamp01((speed - minSpeed) / denominator);

  if (normalizedSpeed <= SPEED_COLOR_STOPS[0].t) {
    return SPEED_COLOR_STOPS[0].color;
  }

  for (let index = 1; index < SPEED_COLOR_STOPS.length; index += 1) {
    const from = SPEED_COLOR_STOPS[index - 1];
    const to = SPEED_COLOR_STOPS[index];
    if (normalizedSpeed <= to.t) {
      const t = (normalizedSpeed - from.t) / Math.max(to.t - from.t, 1e-6);
      return lerpColor(from.color, to.color, t);
    }
  }

  return SPEED_COLOR_STOPS[SPEED_COLOR_STOPS.length - 1].color;
}

function widthForZoom(zoom: number, baseWidth: number) {
  let zoomWidth = LOW_ZOOM_LINE_WIDTH;
  if (zoom >= HIGH_ZOOM_START) {
    const t = clamp01((zoom - HIGH_ZOOM_START) / (HIGH_ZOOM_END - HIGH_ZOOM_START));
    zoomWidth = MID_ZOOM_LINE_WIDTH + (HIGH_ZOOM_LINE_WIDTH - MID_ZOOM_LINE_WIDTH) * t;
  } else if (zoom >= MID_ZOOM_START) {
    const t = clamp01((zoom - MID_ZOOM_START) / (HIGH_ZOOM_START - MID_ZOOM_START));
    zoomWidth = LOW_ZOOM_LINE_WIDTH + (MID_ZOOM_LINE_WIDTH - LOW_ZOOM_LINE_WIDTH) * t;
  }
  return zoomWidth * (baseWidth / DEFAULT_LINE_WIDTH);
}

function validateData(data: StreamlineData) {
  if (data.type !== 'windStreamlines' || data.crs !== 'EPSG:4326') {
    throw new Error('Unsupported streamline data format.');
  }
}

function toThreeboxGeometry(line: StreamlineLine) {
  return line.points.map(([lon, lat, z]) => [lon, lat, z]);
}

function toThreeboxColors(line: StreamlineLine, speedRange: [number, number]) {
  const colors = new Float32Array(line.points.length * 3);
  const [speedMin, speedMax] = speedRange;

  line.points.forEach((point, index) => {
    const color = colorForSpeed(point[3], speedMin, speedMax);
    colors[index * 3] = color[0];
    colors[index * 3 + 1] = color[1];
    colors[index * 3 + 2] = color[2];
  });

  return colors;
}

function setObjectVisible(object: any, visible: boolean) {
  object.visible = visible;
  if (typeof object.traverse === 'function') {
    object.traverse((node: any) => {
      node.visible = visible;
    });
  }
}

function updateLineMaterial(object: any, canvasWidth: number, canvasHeight: number, lineWidth: number) {
  const visit = (node: any) => {
    const material = node?.material;
    if (!material) return;
    material.depthTest = true;
    material.depthWrite = false;
    if (material.resolution?.set) {
      material.resolution.set(canvasWidth, canvasHeight);
    }
    if (typeof material.linewidth === 'number' && Math.abs(material.linewidth - lineWidth) > 0.01) {
      material.linewidth = lineWidth;
      material.needsUpdate = true;
    }
  };

  visit(object);
  if (typeof object?.traverse === 'function') {
    object.traverse(visit);
  }
}

function disposeObject(object: any) {
  if (!object) return;

  if (typeof object.traverse === 'function') {
    object.traverse((node: any) => {
      node.geometry?.dispose?.();
      const material = node.material;
      if (Array.isArray(material)) {
        material.forEach((item) => item?.dispose?.());
      } else {
        material?.dispose?.();
      }
    });
    return;
  }

  object.geometry?.dispose?.();
  const material = object.material;
  if (Array.isArray(material)) {
    material.forEach((item) => item?.dispose?.());
  } else {
    material?.dispose?.();
  }
}

export function createStreamlineLayer(options: StreamlineLayerOptions): StreamlineLayerController {
  let map: Map | null = null;
  let tb: any = null;
  let visible = options.visible;
  let disposed = false;
  let loadFrame: number | null = null;
  const lineObjects: any[] = [];
  const speedRange = options.speedRange ?? DEFAULT_SPEED_RANGE;
  const width = options.width ?? DEFAULT_LINE_WIDTH;
  let currentLineWidth = width;

  const applyVisibility = () => {
    lineObjects.forEach((object) => setObjectVisible(object, visible));
    map?.triggerRepaint();
  };

  const layer: StreamlineLayerController = {
    id: options.id,
    type: 'custom',
    renderingMode: '3d',
    setVisible: (nextVisible) => {
      visible = nextVisible;
      applyVisibility();
    },
    onAdd: (mapInstance, gl) => {
      if (!window.Threebox) {
        console.error('Threebox plugin is not available on window.Threebox');
        return;
      }

      map = mapInstance;
      tb = new window.Threebox(mapInstance, gl, {
        defaultLights: false,
        enableSelectingObjects: false,
        enableDraggingObjects: false,
        multiLayer: true,
      });

      fetch(options.dataUrl)
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Failed to load ${options.dataUrl}: HTTP ${response.status}`);
          }
          return response.json() as Promise<StreamlineData>;
        })
        .then((data) => {
          validateData(data);
          const lines = data.lines.filter((line) => line.points.length >= 2);
          let cursor = 0;

          const addBatch = () => {
            if (disposed || !tb) return;

            const end = Math.min(cursor + ADD_BATCH_SIZE, lines.length);
            for (; cursor < end; cursor += 1) {
              const line = lines[cursor];
              const lineObject = tb.line({
                geometry: toThreeboxGeometry(line),
                vertexColors: true,
                colors: toThreeboxColors(line, speedRange),
                color: '#ffffff',
                width,
                opacity: 0.95,
              });
              lineObject.name = `${options.id}-${line.id}`;
              updateLineMaterial(lineObject, map?.getCanvas().clientWidth ?? window.innerWidth, map?.getCanvas().clientHeight ?? window.innerHeight, currentLineWidth);
              setObjectVisible(lineObject, visible);
              tb.add(lineObject);
              lineObjects.push(lineObject);
            }

            map?.triggerRepaint();
            if (cursor < lines.length) {
              loadFrame = window.requestAnimationFrame(addBatch);
            }
          };

          addBatch();
        })
        .catch((error) => {
          console.error(`[streamline] ${options.id} failed:`, error);
        });
    },
    render: () => {
      if (!tb) return;
      const canvas = map?.getCanvas();
      const zoom = map?.getZoom();
      if (typeof zoom === 'number') {
        currentLineWidth = widthForZoom(zoom, width);
      }
      if (canvas) {
        lineObjects.forEach((object) => updateLineMaterial(object, canvas.clientWidth, canvas.clientHeight, currentLineWidth));
      }
      if (visible) {
        tb.update();
      }
    },
    onRemove: () => {
      disposed = true;
      if (loadFrame !== null) {
        window.cancelAnimationFrame(loadFrame);
        loadFrame = null;
      }
      lineObjects.forEach((object) => disposeObject(object));
      lineObjects.length = 0;
      const labelElement = tb?.labelRenderer?.renderer?.domElement;
      labelElement?.parentNode?.removeChild(labelElement);
      tb = null;
      map = null;
    },
  };

  return layer;
}
