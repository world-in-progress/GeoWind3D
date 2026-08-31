type ConfigFieldType = 'number' | 'boolean' | 'select';
export type BuildingHeightSource = 'roof_mesh' | 'osm';

export type ModelingConfig = {
  tileLevel: number;
  windDirectionDeg: number;
  buildingHeightSource: BuildingHeightSource;
  cleanBuffer: number;
  simplifyTolerance: number;
  gridStep: number;
  buildingBufferDist: number;
  outlierThreshold: number;
  outlierRadius: number;
  outlierMaxIterations: number;
  terrainBuffer: boolean;
  enableBridge: boolean;
  bridgeSampleInterval: number;
  bridgeWidthDefault: number;
  bridgeWidthMaxSearch: number;
};

type ConfigField = {
  key: keyof ModelingConfig;
  label: string;
  description: string;
  type: ConfigFieldType;
  unit?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<number | string>;
};

type ConfigGroup = {
  id: string;
  title: string;
  fields: ConfigField[];
};

function parseBoolean(value: string | undefined, defaultValue = false): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export const MODELING_CONFIG_DEFAULTS: ModelingConfig = {
  tileLevel: 19,
  windDirectionDeg: 0,
  buildingHeightSource: 'roof_mesh',
  cleanBuffer: 0.1,
  simplifyTolerance: 0.000002,
  gridStep: 1,
  buildingBufferDist: 6,
  outlierThreshold: 3,
  outlierRadius: 20,
  outlierMaxIterations: 50,
  terrainBuffer: true,
  enableBridge: true,
  bridgeSampleInterval: 1,
  bridgeWidthDefault: 2.5,
  bridgeWidthMaxSearch: 10,
};

export const MODELING_CONFIG_GROUPS: ConfigGroup[] = [
  {
    id: 'study-area',
    title: 'Study Area and Data Source',
    fields: [
      {
        key: 'tileLevel',
        label: '3D Tiles Level',
        description: 'Level of detail used when extracting source 3D Tiles for the selected study area.',
        type: 'select',
        options: [13, 14, 15, 16, 17, 18, 19],
      },
      {
        key: 'windDirectionDeg',
        label: 'Wind Direction',
        description: 'Incoming wind direction in degrees, used to orient the simulation domain.',
        type: 'number',
        unit: 'deg',
        min: 0,
        max: 359,
        step: 1,
      },
    ],
  },
  {
    id: 'building',
    title: 'Building Modeling',
    fields: [
      {
        key: 'buildingHeightSource',
        label: 'Building Height Source',
        description: 'Source used to attribute roof elevation for corrected building members.',
        type: 'select',
        options: ['roof_mesh', 'osm'],
      },
    ],
  },
  {
    id: 'terrain',
    title: 'Terrain Modeling',
    fields: [
      {
        key: 'gridStep',
        label: 'Grid Step',
        description: 'Spacing of terrain elevation sampling points within the study area.',
        type: 'number',
        unit: 'm',
        min: 1,
        max: 20,
        step: 0.5,
      },
      {
        key: 'outlierThreshold',
        label: 'Outlier Threshold',
        description: 'Elevation threshold above the local median used to remove non-terrain samples.',
        type: 'number',
        unit: 'm',
        min: 0,
        max: 20,
        step: 0.5,
      },
      {
        key: 'outlierRadius',
        label: 'Outlier Radius',
        description: 'Search radius used when computing the local median for terrain outlier filtering.',
        type: 'number',
        unit: 'm',
        min: 1,
        max: 100,
        step: 1,
      },
      {
        key: 'outlierMaxIterations',
        label: 'Outlier Iterations',
        description: 'Maximum number of iterative local outlier filtering passes.',
        type: 'number',
        min: 1,
        max: 200,
        step: 1,
      },
      {
        key: 'terrainBuffer',
        label: 'OpenFOAM Terrain Buffer',
        description: 'Generate the expanded terrain transition buffer used by OpenFOAM case preparation.',
        type: 'boolean',
      },
    ],
  },
  {
    id: 'elevated-walkway',
    title: 'Elevated Walkway Modeling',
    fields: [
      {
        key: 'enableBridge',
        label: 'Enable Elevated Walkways',
        description: 'Reconstruct elevated walkway geometry and include it in downstream model integration.',
        type: 'boolean',
      },
      {
        key: 'bridgeSampleInterval',
        label: 'Line Sample Interval',
        description: 'Sampling interval along elevated walkway centerlines.',
        type: 'number',
        unit: 'm',
        min: 0.25,
        max: 10,
        step: 0.25,
      },
      {
        key: 'bridgeWidthMaxSearch',
        label: 'Max Width Search',
        description: 'Maximum normal-direction search distance used for walkway edge detection.',
        type: 'number',
        unit: 'm',
        min: 1,
        max: 30,
        step: 0.5,
      },
    ],
  },
];

function clamp(value: number, min?: number, max?: number): number {
  let next = value;
  if (min !== undefined) next = Math.max(min, next);
  if (max !== undefined) next = Math.min(max, next);
  return next;
}

function coerceNumber(raw: unknown, fallback: number, field?: ConfigField): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(parsed, field?.min, field?.max);
}

function coerceBoolean(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return parseBoolean(raw, fallback);
  return fallback;
}

function coerceHeightSource(raw: unknown, fallback: BuildingHeightSource): BuildingHeightSource {
  return raw === 'osm' || raw === 'roof_mesh' ? raw : fallback;
}

export function getModelConfigResponse() {
  const {
    cleanBuffer: _legacyCleanBuffer,
    simplifyTolerance: _legacySimplifyTolerance,
    ...defaults
  } = MODELING_CONFIG_DEFAULTS;
  return {
    defaults,
    groups: MODELING_CONFIG_GROUPS,
  };
}

export function normalizeModelingConfig(raw: unknown): ModelingConfig {
  const input = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const next = { ...MODELING_CONFIG_DEFAULTS };
  const fields = MODELING_CONFIG_GROUPS.flatMap((group) => group.fields);

  for (const field of fields) {
    const fallback = next[field.key];
    const rawValue = input[field.key];
    if (field.key === 'buildingHeightSource') {
      next[field.key] = coerceHeightSource(rawValue, fallback as BuildingHeightSource) as never;
    } else if (field.type === 'boolean') {
      next[field.key] = coerceBoolean(rawValue, fallback as boolean) as never;
    } else {
      next[field.key] = coerceNumber(rawValue, fallback as number, field) as never;
    }
  }

  next.windDirectionDeg = ((next.windDirectionDeg % 360) + 360) % 360;
  return next;
}
