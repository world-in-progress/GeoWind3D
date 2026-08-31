import type { Feature, GeoJsonProperties, Polygon } from 'geojson';

export class GeoJSONValidationError extends Error {}

function isPosition(value: unknown): value is number[] {
    return Array.isArray(value) &&
        value.length >= 2 &&
        typeof value[0] === 'number' &&
        typeof value[1] === 'number' &&
        Number.isFinite(value[0]) &&
        Number.isFinite(value[1]);
}

function isClosedRing(value: unknown): value is number[][] {
    if (!Array.isArray(value) || value.length < 4 || !value.every(isPosition)) return false;
    const first = value[0];
    const last = value[value.length - 1];
    return first[0] === last[0] && first[1] === last[1];
}

function isPolygonGeometry(value: unknown): value is Polygon {
    if (!value || typeof value !== 'object') return false;
    const geometry = value as { type?: unknown; coordinates?: unknown };
    return geometry.type === 'Polygon' &&
        Array.isArray(geometry.coordinates) &&
        geometry.coordinates.length > 0 &&
        geometry.coordinates.every(isClosedRing);
}

export function normalizeSinglePolygonFeature(value: unknown): Feature<Polygon> {
    if (!value || typeof value !== 'object') {
        throw new GeoJSONValidationError('bound must be a single Polygon Feature or a FeatureCollection containing one Polygon Feature.');
    }

    const geojson = value as {
        type?: unknown;
        geometry?: unknown;
        properties?: unknown;
        features?: unknown;
    };

    if (geojson.type === 'Feature') {
        if (!isPolygonGeometry(geojson.geometry)) {
            throw new GeoJSONValidationError('bound Feature must contain exactly one Polygon geometry.');
        }
        return {
            type: 'Feature' as const,
            properties: geojson.properties && typeof geojson.properties === 'object'
                ? geojson.properties as GeoJsonProperties
                : {},
            geometry: geojson.geometry,
        };
    }

    if (geojson.type === 'FeatureCollection') {
        if (!Array.isArray(geojson.features) || geojson.features.length !== 1) {
            throw new GeoJSONValidationError('bound FeatureCollection must contain exactly one feature.');
        }
        return normalizeSinglePolygonFeature(geojson.features[0]);
    }

    throw new GeoJSONValidationError('bound must be a single Polygon Feature or a FeatureCollection containing one Polygon Feature.');
}
