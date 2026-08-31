export type LayerVisibility = {
  tiles3d: boolean;
  selectedTileBounds: boolean;
  osmBuildings: boolean;
  excludedBuildings: boolean;
  osmElevatedWay: boolean;
  generatedObjModel: boolean;
  roofClusterMesh: boolean;
  buildingPatches: boolean;
  terrainModel: boolean;
  terrainSamplePoints: boolean;
  elevatedWaySamplePoints: boolean;
  elevatedWayFootprints: boolean;
  elevatedWayGraph: boolean;
  corridorSurface: boolean;
  windDirection: boolean;
  inputArea: boolean;
  streamline: boolean;
  visualizationExampleModel: boolean;
  visualizationExampleTerrainModel: boolean;
  visualizationExampleWalkwayModel: boolean;
};

export const INITIAL_LAYER_VISIBILITY: LayerVisibility = {
  tiles3d: true,
  selectedTileBounds: false,
  osmBuildings: false,
  excludedBuildings: false,
  osmElevatedWay: false,
  generatedObjModel: true,
  roofClusterMesh: false,
  buildingPatches: false,
  terrainModel: true,
  terrainSamplePoints: false,
  elevatedWaySamplePoints: false,
  elevatedWayFootprints: false,
  elevatedWayGraph: false,
  corridorSurface: true,
  windDirection: true,
  inputArea: false,
  streamline: false,
  visualizationExampleModel: false,
  visualizationExampleTerrainModel: false,
  visualizationExampleWalkwayModel: false,
};

export type LayerItem = {
  key: keyof LayerVisibility;
  label: string;
  phase: 'source' | 'intermediate' | 'final' | 'visualization';
};

export const LAYER_TREE_GROUPS: { id: string; title: string; items: LayerItem[] }[] = [
  {
    id: 'source',
    title: 'Source Data',
    items: [
      { key: 'tiles3d', label: '3D Tiles', phase: 'source' },
      { key: 'inputArea', label: 'Study Area', phase: 'source' },
      { key: 'windDirection', label: 'Wind Direction', phase: 'source' },
      { key: 'osmBuildings', label: 'OSM Buildings', phase: 'source' },
      { key: 'excludedBuildings', label: 'Excluded Buildings', phase: 'source' },
      { key: 'osmElevatedWay', label: 'OSM Elevated Walkways', phase: 'source' },
    ],
  },
  {
    id: 'intermediate',
    title: 'Intermediate Results',
    items: [
      { key: 'selectedTileBounds', label: 'Selected Tile Bounds', phase: 'intermediate' },
      { key: 'roofClusterMesh', label: 'Roof Cluster Mesh', phase: 'intermediate' },
      { key: 'buildingPatches', label: 'Aligned Building Clusters', phase: 'intermediate' },
      { key: 'terrainSamplePoints', label: 'Terrain Sample Points', phase: 'intermediate' },
      { key: 'elevatedWaySamplePoints', label: 'Walkway Sample Points', phase: 'intermediate' },
      { key: 'elevatedWayFootprints', label: 'Walkway Footprints', phase: 'intermediate' },
      { key: 'elevatedWayGraph', label: 'Walkway Graph', phase: 'intermediate' },
    ],
  },
  {
    id: 'final',
    title: 'Output Models',
    items: [
      { key: 'generatedObjModel', label: 'Building Model', phase: 'final' },
      { key: 'terrainModel', label: 'Terrain Model', phase: 'final' },
      { key: 'corridorSurface', label: 'Elevated Walkway Model', phase: 'final' },
    ],
  },
  {
    id: 'visualization',
    title: 'Visualization Examples',
    items: [
      { key: 'streamline', label: 'Wind Streamline', phase: 'visualization' },
      { key: 'visualizationExampleModel', label: 'Example Building Model', phase: 'visualization' },
      { key: 'visualizationExampleTerrainModel', label: 'Example Terrain Model', phase: 'visualization' },
      { key: 'visualizationExampleWalkwayModel', label: 'Example Elevated Walkway Model', phase: 'visualization' },
    ],
  },
];
