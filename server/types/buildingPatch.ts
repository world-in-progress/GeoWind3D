import type { MultiPolygon, Polygon } from 'geojson';

export type BuildingPatchGeometry = Polygon | MultiPolygon;

// Single patch base heights: [polygon][ring][vertex] = z.
export type BuildingPatchBaseHeights = number[][][];

export type BuildingPatchBasePlane = {
  a: number;
  b: number;
  c: number;
  source?: 'ransac' | 'median' | string;
};

export type BuildingOsmType =
  | 'building'
  | 'building_part'
  | 'building_commercial'
  | 'building_residential';

export type BuildingPatchMember = {
  fullId: string;
  osmType: BuildingOsmType;
  geometry: BuildingPatchGeometry;
  osmHeight?: string | null;
  osmBuildingLevels?: string | null;
  roofZ?: number | null;
  heightSource?: string | null;
  osmRelativeHeight?: number | null;
  heightTerrainZ?: number | null;
};

export type BuildingPatch = {
  id: string;
  geometry: BuildingPatchGeometry;
  members: BuildingPatchMember[];
  baseHeights: BuildingPatchBaseHeights | null;
  basePlane?: BuildingPatchBasePlane | null;
};
