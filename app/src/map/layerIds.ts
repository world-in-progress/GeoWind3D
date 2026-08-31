export const OSM_BUILDING_SOURCE_ID = 'osm-building-vector-source'
export const OSM_BUILDING_FILL_LAYER_ID = 'osm-building-fill'
export const OSM_BUILDING_LINE_LAYER_ID = 'osm-building-line'
export const EXCLUDED_BUILDINGS_SOURCE_ID = 'excluded-buildings-source'
export const EXCLUDED_BUILDINGS_HIT_FILL_LAYER_ID = 'excluded-buildings-hit-fill'
export const EXCLUDED_BUILDINGS_LINE_LAYER_ID = 'excluded-buildings-line'
export const INPUT_AREA_SOURCE_ID = 'input-area-source'
export const INPUT_AREA_LINE_LAYER_ID = 'input-area-line'
export const SELECTED_TILE_SOURCE_ID = 'selected-tiles-source'
export const SELECTED_TILE_FILL_LAYER_ID = 'selected-tiles-fill'
export const SELECTED_TILE_LINE_LAYER_ID = 'selected-tiles-line'
export const SELECTED_TILE_LAYER_IDS = [SELECTED_TILE_FILL_LAYER_ID, SELECTED_TILE_LINE_LAYER_ID]
export const SELECTED_TILE_SOURCE_IDS = [SELECTED_TILE_SOURCE_ID]
export const BUILDING_PATCHES_SOURCE_ID = 'building-patches-source'
export const BUILDING_PATCHES_FILL_LAYER_ID = 'building-patches-fill'
export const BUILDING_PATCHES_LINE_LAYER_ID = 'building-patches-line'
export const TERRAIN_SAMPLE_POINTS_SOURCE_ID = 'terrain-sample-points-source'
export const TERRAIN_SAMPLE_POINTS_LAYER_ID = 'terrain-sample-points-circle'
export const OSM_ELEVATED_WAY_SOURCE_ID = 'osm-elevated-walkway-vector-source'
export const OSM_ELEVATED_WAY_LINE_LAYER_ID = 'osm-elevated-walkway-line'
export const EW_SAMPLE_POINTS_SOURCE_ID = 'ew-sample-points-source'
export const EW_SAMPLE_POINTS_LAYER_ID = 'ew-sample-points-extrusion'
export const EW_FOOTPRINTS_SOURCE_ID = 'ew-footprints-source'
export const EW_FOOTPRINTS_FILL_LAYER_ID = 'ew-footprints-fill'
export const EW_FOOTPRINTS_LINE_LAYER_ID = 'ew-footprints-line'
export const EW_GRAPH_SOURCE_ID = 'ew-graph-source'
export const EW_GRAPH_EDGE_LAYER_ID = 'ew-graph-edge-line'
export const EW_GRAPH_NODE_LAYER_ID = 'ew-graph-node-circle'
export const EW_GRAPH_LABEL_LAYER_ID = 'ew-graph-node-label'
export const WIND_ARROW_LINE_SOURCE_ID = 'wind-arrow-line-source'
export const WIND_ARROW_HEAD_SOURCE_ID = 'wind-arrow-head-source'
export const WIND_ARROW_LINE_LAYER_ID = 'wind-arrow-line'
export const WIND_ARROW_HEAD_LAYER_ID = 'wind-arrow-head'
export const STREAMLINE_SPEED_RANGE: [number, number] = [0, 5]

export const TILES_3D_LAYER_ID = 'threebox-3dtiles-layer'
export const BUILDING_MODEL_LAYER_ID = 'threebox-generated-obj-layer'
export const TERRAIN_MODEL_LAYER_ID = 'threebox-terrain-obj-layer'
export const ELEVATED_WALKWAY_MODEL_LAYER_ID = 'threebox-corridor-surface-layer'
export const EXAMPLE_BUILDING_MODEL_LAYER_ID = 'threebox-visualization-example-model-layer'
export const EXAMPLE_TERRAIN_MODEL_LAYER_ID = 'threebox-visualization-example-terrain-model-layer'
export const EXAMPLE_WALKWAY_MODEL_LAYER_ID = 'threebox-visualization-example-walkway-model-layer'
export const ROOF_CLUSTER_MESH_LAYER_IDS = [
  'threebox-roof-cluster-mesh-rank-1-layer',
  'threebox-roof-cluster-mesh-rank-2-layer',
  'threebox-roof-cluster-mesh-rank-3-layer',
] as const
