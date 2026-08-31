export type ModelingConfigValue = number | boolean | string;
export type BuildingHeightSource = 'roof_mesh' | 'osm';

export type ModelingConfig = {
  tileLevel: number;
  windDirectionDeg: number;
  buildingHeightSource: BuildingHeightSource;
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

export type ConfigFieldType = 'number' | 'boolean' | 'select';

export type ConfigField = {
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

export type ConfigGroup = {
  id: string;
  title: string;
  fields: ConfigField[];
};

export type ModelConfigResponse = {
  defaults: ModelingConfig;
  groups: ConfigGroup[];
};
