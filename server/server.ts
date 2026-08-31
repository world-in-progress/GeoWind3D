import dotenv from 'dotenv';
dotenv.config({ quiet: true });

import express, { Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import type { Feature, Polygon } from 'geojson';
import { processData, processDataWithArtifacts } from './service/processService';
import { getOSMVectorTile, isOSMValidationError, normalizeOSMError } from './service/osmService';
import {
    applyBaseHeightsToPatches,
    queryExcludedBuildingFeatures,
    runBuildingModeling,
} from './service/building3DService';
import { runTerrainGeneration } from './service/terrainService';
import { generateOpenFOAMCase } from './service/openfoamService';
import { buildElevatedWayGraph, buildElevatedWaySurface } from './service/elevatedWayService';
import { runStructureUnion } from './service/integrationService';
import {
    buildRefinedBuildingPatches,
    type BuildingPatchRefinementResult,
} from './service/building2DService';
import { formatMs } from './utils/geoUtils';
import { LazyRTreeSurfaceSampler } from './utils/surfaceSampler';
import { getModelConfigResponse, normalizeModelingConfig, type ModelingConfig } from './config/modelingConfig';
import {
    createTask,
    createTaskLogger,
    getTask,
    markTaskCompleted,
    markTaskFailed,
    markTaskRunning,
    subscribeTaskEvents,
    type TaskLogger,
} from './service/taskService';
import { createZipFromDirectory } from './utils/zipDirectory';
import { GeoJSONValidationError, normalizeSinglePolygonFeature } from './utils/geojsonValidation';

const app = express();
const PORT = process.env.PORT;
const TILE_DATA_DIR = process.env.TILE_DATA_DIR || '';
const TEMP_DIR = process.env.TEMP_DIR || path.resolve('temp');
const DEBUG_HEIGHT_SAMPLE_TILE_LEVEL = 20;
const DEBUG_HEIGHT_SAMPLE_HALF_SIZE_DEG = 0.00002;

// Allow all origins for prototype use.
app.use(cors());

// Parse JSON request bodies.
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

if (TILE_DATA_DIR && fs.existsSync(TILE_DATA_DIR)) {
    const staticRoot = path.resolve(TILE_DATA_DIR);
    app.use('/3dtiles/3857', express.static(staticRoot));
    app.use('/3dtiles', express.static(staticRoot));
    console.log(`3dtiles static root: ${staticRoot}`);
} else {
    console.warn('TILE_DATA_DIR is missing or invalid, /3dtiles static route is disabled.');
}

if (TEMP_DIR && fs.existsSync(TEMP_DIR)) {
    const outputsRoot = path.resolve(TEMP_DIR);
    app.use('/outputs', express.static(outputsRoot));
    console.log(`outputs static root: ${outputsRoot}`);
} else {
    console.warn('TEMP_DIR is missing or invalid, /outputs static route is disabled.');
}

// Processing routes.

// Service information.
app.get('/', (req: Request, res: Response) => {
    res.json({
        message: 'GeoWind3D API service is running',
        status: 'success'
    });
});

// Health check.
app.get('/health', (req: Request, res: Response) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString()
    });
});

// General processing endpoint.
app.post('/process', async (req: Request, res: Response) => {
    try {
        const { bound, level } = req.body;
        const normalizedBound = normalizeSinglePolygonFeature(bound);
        const result = await processData(normalizedBound, level);
        res.json({
            success: true,
            data: result
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request.';
        const statusCode = error instanceof GeoJSONValidationError ? 400 : 500;
        res.status(statusCode).json({ success: false, error: message });
    }
});

// OSM MVT routes.

app.get('/osm/mvt/:table/:z/:x/:y.mvt', async (req: Request, res: Response) => {
    try {
        const { table, z, x, y } = req.params;
        const tile = await getOSMVectorTile(table, z, x, y);
        res.setHeader('Content-Type', 'application/vnd.mapbox-vector-tile');
        res.setHeader('Cache-Control', 'public, max-age=60');
        res.send(tile);
    } catch (error) {
        const message = normalizeOSMError(error);
        const statusCode = isOSMValidationError(error) ? 400 : 500;
        res.status(statusCode).json({ success: false, error: message });
    }
});

app.get('/buildings/excluded', async (_req: Request, res: Response) => {
    try {
        const geojson = await queryExcludedBuildingFeatures();
        res.setHeader('Cache-Control', 'no-cache');
        res.json({ success: true, data: geojson });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to query excluded buildings.';
        res.status(500).json({ success: false, error: message });
    }
});

// City-model generation routes.

app.get('/model/config', (_req: Request, res: Response) => {
    res.json(getModelConfigResponse());
});

function createDebugPointBound(lon: number, lat: number): Feature<Polygon> {
    const d = DEBUG_HEIGHT_SAMPLE_HALF_SIZE_DEG;
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [[
                [lon - d, lat - d],
                [lon + d, lat - d],
                [lon + d, lat + d],
                [lon - d, lat + d],
                [lon - d, lat - d],
            ]],
        },
    };
}

app.post('/debug/height-sample', async (req: Request, res: Response) => {
    const startedAt = Date.now();
    try {
        const lon = Number(req.body?.lon);
        const lat = Number(req.body?.lat);
        if (!Number.isFinite(lon) || !Number.isFinite(lat) || lon < -180 || lon > 180 || lat < -90 || lat > 90) {
            res.status(400).json({ success: false, error: 'Invalid lon/lat.' });
            return;
        }

        const bound = createDebugPointBound(lon, lat);
        const artifacts = await processDataWithArtifacts(bound, DEBUG_HEIGHT_SAMPLE_TILE_LEVEL, {
            mergeOutput: false,
        });
        const sampler = new LazyRTreeSurfaceSampler(artifacts.objPathMap, artifacts.rootSpatial.transform);
        const height = sampler.sampleHeightAtPoint(lon, lat);
        res.json({
            success: true,
            data: {
                lon,
                lat,
                height,
                level: DEBUG_HEIGHT_SAMPLE_TILE_LEVEL,
                tileCount: sampler.getTileCount(),
                cachedTileCount: sampler.getCachedTileCount(),
                elapsedMs: Date.now() - startedAt,
            },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Height sampling failed.';
        res.status(500).json({ success: false, error: message });
    }
});

async function runModelGenerationWorkflow(
    normalizedBound: Feature<Polygon>,
    requestConfig: ModelingConfig,
    taskId: string,
    taskDir: string,
    logger?: TaskLogger,
) {
    const level = requestConfig.tileLevel;
    const toTaskRelativePath = (filePath: string | null | undefined): string | null => {
        if (!filePath) return null;
        return path.relative(taskDir, filePath).replace(/\\/g, '/');
    };
    const toOutputUrl = (filePath: string | null | undefined): string | null => {
        if (!filePath || !fs.existsSync(filePath)) return null;
        const relativePath = path.relative(path.resolve(TEMP_DIR), path.resolve(filePath)).replace(/\\/g, '/');
        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) return null;
        return `/outputs/${relativePath}`;
    };
    const writeTaskTransformMetadata = (
        metadata: {
            generatedAt: string;
            originLonLat: [number, number];
            offset2326: [number, number];
            mercatorZScale: number;
            files: Record<string, string | string[] | null>;
        },
    ): string => {
        const jsonPath = path.join(taskDir, 'model_transform.json');
        const payload = {
            taskId,
            generatedAt: metadata.generatedAt,
            coordinateSpace: {
                objVertexSpace: 'EPSG:2326 local offset coordinates',
                horizontalCRS: 'EPSG:2326',
                verticalCoordinate: 'absolute sampled elevation stored directly in OBJ z',
                offset_2326: metadata.offset2326,
                origin_lonlat: metadata.originLonLat,
                mercatorZScale: metadata.mercatorZScale,
            },
            restoreToEPSG2326: {
                x_2326: 'obj_x + offset_2326[0]',
                y_2326: 'obj_y + offset_2326[1]',
                z: 'obj_z',
            },
            restoreToWGS84: {
                horizontal: 'Transform (x_2326, y_2326) from EPSG:2326 to EPSG:4326.',
                z: 'Keep obj_z as absolute elevation.',
            },
            files: metadata.files,
        };

        fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
        console.log(`[task] transform metadata saved: ${jsonPath}`);
        return jsonPath;
    };

    // Keep every output from a run in one task directory.
    fs.mkdirSync(taskDir, { recursive: true });
    console.log(`[task] task directory: ${taskDir}`);
    logger?.log('task', `elevated way enabled: ${requestConfig.enableBridge}`);
    const totalStart = Date.now();

    // Preprocess tiles from B3DM to OBJ.
    const meshPreparationStart = Date.now();
    const artifacts = await processDataWithArtifacts(normalizedBound, Number(level), {
        mergeOutput: false,
        logger,
    });
    logger?.log('timing', `b3dm2obj/mesh preparation | elapsed=${formatMs(Date.now() - meshPreparationStart)}`);

    // Build the lazily loaded tile-level R-tree sampler.
    const samplerSetupStart = Date.now();
    const surfaceSampler = new LazyRTreeSurfaceSampler(
        artifacts.objPathMap,
        artifacts.rootSpatial.transform,
    );
    if (surfaceSampler.getTileCount() === 0) {
        throw new Error('No source OBJ tiles available for surface sampling.');
    }
    logger?.log('model', `surface sampler ready: tiles=${surfaceSampler.getTileCount()}`);
    logger?.log('timing', `surface sampler setup | elapsed=${formatMs(Date.now() - samplerSetupStart)}`);

    // Construct refined 2D building patches and the shared origin.
    const patchBuildResult: BuildingPatchRefinementResult = await buildRefinedBuildingPatches(
        normalizedBound,
        surfaceSampler,
        taskDir,
        requestConfig,
        logger,
    );
    const studyArea = patchBuildResult.studyArea;

    // Construct the corridor graph before building and terrain modeling.
    const ewStart = Date.now();
    const emptyElevatedWay = {
        geojson: { type: 'FeatureCollection', features: [] },
        footprintsGeojson: { type: 'FeatureCollection', features: [] },
        stripsGeojson: { type: 'FeatureCollection', features: [] },
        edgesZ: [],
        nodesZ: [],
        samplePoints: [],
        surface: null,
        stats: { component_count: 0, node_count: 0, edge_count: 0, feature_count: 0, total_outliers: 0, building_outliers: 0 },
    };
    const elevatedWayResult = requestConfig.enableBridge
        ? await buildElevatedWayGraph(
            surfaceSampler,
            studyArea,
            patchBuildResult.buildingPatches,
            {
                taskDir,
                sampleInterval: requestConfig.bridgeSampleInterval,
                defaultHalfWidth: requestConfig.bridgeWidthDefault,
                maxWidthSearch: requestConfig.bridgeWidthMaxSearch,
                logger,
            },
        )
        : emptyElevatedWay;
    logger?.log('timing', `elevated way graph | elapsed=${formatMs(Date.now() - ewStart)}`);

    // Build the 3D corridor after the building query provides the shared origin.
    if (requestConfig.enableBridge && elevatedWayResult && elevatedWayResult.footprintsGeojson?.features?.length) {
        const surfStart = Date.now();
        elevatedWayResult.surface = await buildElevatedWaySurface(
            elevatedWayResult,
            patchBuildResult.origin,
            taskDir,
            { logger },
        );
        logger?.log('timing', `elevated way surface | elapsed=${formatMs(Date.now() - surfStart)}`);
    }

    const corridorObjPath = elevatedWayResult?.surface
        ? path.join(taskDir, 'elevated_way', 'elevated_walkway.obj')
        : null;

    // Sample terrain, run CDT, and assign building-base Z values.
    // Terrain samples inside corridor footprints receive interpolated Z values instead of ray samples.
    const terrainResult = await runTerrainGeneration(
        studyArea,
        surfaceSampler,
        patchBuildResult.buildingPatches,
        patchBuildResult.boundaryBuildings,
        patchBuildResult.origin,
        taskDir,
        requestConfig.enableBridge ? elevatedWayResult?.footprintsGeojson ?? null : null,
        requestConfig.enableBridge ? corridorObjPath : null,
        requestConfig.windDirectionDeg,
        requestConfig,
        logger,
    );

    applyBaseHeightsToPatches(
        patchBuildResult.buildingPatches,
        terrainResult?.buildingBaseHeights,
        terrainResult?.buildingBasePlanes,
    );

    // Model buildings using attributed roof Z values and terrain-derived base Z values.
    const buildingResult = await runBuildingModeling(
        patchBuildResult,
        surfaceSampler,
        taskDir,
        requestConfig,
        logger,
    );

    // Boolean-union watertight buildings and corridors into structure.obj.
    // This intermediate model is reserved for later terrain integration and is not displayed.
    const structureResult = await runStructureUnion(
        buildingResult.buildingObjPath,
        requestConfig.enableBridge ? corridorObjPath : null,
        taskDir,
        logger,
    );

    // Generate the OpenFOAM case directory.
    const ofStart = Date.now();
    const { casePath } = generateOpenFOAMCase(
        structureResult.objPath,
        terrainResult?.terrainObjPath,
        taskDir,
        { includeWalkwayRefinement: requestConfig.enableBridge },
        logger,
    );
    const caseRelPath = path.relative(path.resolve(TEMP_DIR), casePath).replace(/\\/g, '/');
    logger?.log('timing', `OpenFOAM case generation | elapsed=${formatMs(Date.now() - ofStart)}`);
    logger?.log('timing', `total model generation | elapsed=${formatMs(Date.now() - totalStart)}`);

    // Assemble the response.
    const buildingPatchesGeojson = patchBuildResult.buildingPatchesGeojson;
    const buildingPatchesGeojsonPath = patchBuildResult.buildingPatchesGeojsonPath;
    const completedAt = new Date().toISOString();
    const roofClusterMeshObjUrls = buildingResult.roofClusterMeshOutputPaths
        .map((filePath) => toOutputUrl(filePath))
        .filter((url): url is string => Boolean(url));
    const roofClusterMeshOriginLonLat = patchBuildResult.origin.lonlat;
    const roofClusterMeshColors = ['#42d9ff', '#ff66a8', '#ffd84d'];
    const roofClusterMeshes = roofClusterMeshObjUrls.length > 0
        ? roofClusterMeshObjUrls.map((objUrl, index) => ({
            rank: index + 1,
            color: roofClusterMeshColors[index] ?? '#d9f99d',
            objUrl,
            placement: {
                coords: roofClusterMeshOriginLonLat,
                rotation: { x: 0, y: 0, z: 180 },
                scale: 1,
                mercatorZScale: Math.cos(roofClusterMeshOriginLonLat[1] * Math.PI / 180),
                anchor: 'none',
            },
            localCRS: 'epsg2326-local-offset',
            upAxis: 'Z',
        }))
        : [];
    const transformMetadataPath = writeTaskTransformMetadata({
        generatedAt: completedAt,
        originLonLat: patchBuildResult.origin.lonlat,
        offset2326: patchBuildResult.origin.offset_2326,
        mercatorZScale: patchBuildResult.origin.mercatorZScale,
        files: {
            buildingObj: toTaskRelativePath(buildingResult.buildingObjPath),
            terrainObj: toTaskRelativePath(terrainResult?.terrainObjPath),
            corridorObj: toTaskRelativePath(corridorObjPath),
            structureObj: toTaskRelativePath(structureResult.objPath),
            openfoamCase: toTaskRelativePath(casePath),
            buildingPatchesGeojson: toTaskRelativePath(buildingPatchesGeojsonPath),
            roofClusterMeshObjs: buildingResult.roofClusterMeshOutputPaths
                .map((filePath) => toTaskRelativePath(filePath))
                .filter((filePath): filePath is string => Boolean(filePath)),
        },
    });

    return {
        data: {
            status: 'completed',
            processingCompleted: true,
            completedAt,
            tileScopes: artifacts.targetTiles.tileScopes,
            tileIds: artifacts.targetTiles.tileIds,
            building: buildingResult.building,
            quality: buildingResult.quality,
            sampling: {
                roofClusterMeshes,
            },
            buildingPatches: buildingPatchesGeojson,
            transformMetadata: {
                jsonPath: toTaskRelativePath(transformMetadataPath),
                offset_2326: patchBuildResult.origin.offset_2326,
                origin_lonlat: patchBuildResult.origin.lonlat,
                localCRS: 'EPSG:2326 local offset',
            },
            openfoam: { casePath: caseRelPath },
            terrain: terrainResult?.terrain || null,
            terrainSampling: terrainResult?.sampling || null,
            domain: terrainResult?.domain || null,
            elevatedWay: {
                enabled: requestConfig.enableBridge,
                geojson: elevatedWayResult.geojson,
                footprintsGeojson: elevatedWayResult.footprintsGeojson,
                samplePoints: elevatedWayResult.samplePoints,
                surface: elevatedWayResult.surface,
                stats: elevatedWayResult.stats,
            },
        },
        openfoamCasePath: casePath,
    };
}

app.post('/model/tasks', (req: Request, res: Response) => {
    try {
        const requestConfig = normalizeModelingConfig({
            ...(req.body?.config ?? req.body?.modelingConfig ?? {}),
            tileLevel: req.body?.tileLevel ?? req.body?.level ?? req.body?.config?.tileLevel ?? req.body?.modelingConfig?.tileLevel,
            windDirectionDeg: req.body?.windDirectionDeg ?? req.body?.config?.windDirectionDeg ?? req.body?.modelingConfig?.windDirectionDeg,
        });
        const normalizedBound = normalizeSinglePolygonFeature(req.body?.bound);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const suffix = Math.random().toString(36).slice(2, 8);
        const taskId = `${timestamp}-${suffix}`;
        const taskDir = path.join(path.resolve(TEMP_DIR), 'tasks', taskId);
        createTask(taskId);
        const logger = createTaskLogger(taskId);

        res.status(202).json({ success: true, taskId });

        setImmediate(async () => {
            markTaskRunning(taskId);
            const taskStart = Date.now();
            logger.log('task', `task started | level=${requestConfig.tileLevel}`);
            try {
                const { data, openfoamCasePath } = await runModelGenerationWorkflow(
                    normalizedBound,
                    requestConfig,
                    taskId,
                    taskDir,
                    logger,
                );
                logger.log('task', `task completed | elapsed=${formatMs(Date.now() - taskStart)}`);
                markTaskCompleted(taskId, data, openfoamCasePath);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                if (error instanceof Error && error.stack) {
                    console.error(error.stack);
                }
                logger.error('task', `task failed: ${message}`);
                markTaskFailed(taskId, message);
            }
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Invalid request.';
        const statusCode = error instanceof GeoJSONValidationError ? 400 : 500;
        res.status(statusCode).json({ success: false, error: message });
    }
});

app.get('/model/tasks/:taskId/events', (req: Request, res: Response) => {
    const ok = subscribeTaskEvents(req.params.taskId, res);
    if (!ok) {
        res.status(404).json({ success: false, error: 'Task not found.' });
    }
});

app.get('/model/tasks/:taskId/result', (req: Request, res: Response) => {
    const task = getTask(req.params.taskId);
    if (!task) {
        res.status(404).json({ success: false, error: 'Task not found.' });
        return;
    }
    if (task.status !== 'completed') {
        res.status(409).json({ success: false, error: `Task is ${task.status}.` });
        return;
    }
    res.json({ success: true, data: task.result });
});

app.get('/model/tasks/:taskId/openfoam.zip', (req: Request, res: Response) => {
    const task = getTask(req.params.taskId);
    if (!task) {
        res.status(404).json({ success: false, error: 'Task not found.' });
        return;
    }
    if (task.status !== 'completed') {
        res.status(409).json({ success: false, error: `Task is ${task.status}.` });
        return;
    }
    if (!task.openfoamCasePath || !fs.existsSync(task.openfoamCasePath)) {
        res.status(404).json({ success: false, error: 'OpenFOAM case is not available.' });
        return;
    }
    const tempRoot = path.resolve(TEMP_DIR);
    const caseRelativePath = path.relative(tempRoot, path.resolve(task.openfoamCasePath));
    if (caseRelativePath && (caseRelativePath.startsWith('..') || path.isAbsolute(caseRelativePath))) {
        res.status(400).json({ success: false, error: 'Invalid OpenFOAM case path.' });
        return;
    }

    const zipPath = path.join(tempRoot, 'tasks', task.taskId, 'downloads', 'openfoam_case.zip');
    createZipFromDirectory(task.openfoamCasePath, zipPath);
    res.download(zipPath, `${task.taskId}_openfoam_case.zip`);
});

// Start the server.
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
