const isPosition = (value: unknown): value is number[] =>
  Array.isArray(value) &&
  value.length >= 2 &&
  typeof value[0] === 'number' &&
  typeof value[1] === 'number' &&
  Number.isFinite(value[0]) &&
  Number.isFinite(value[1])

const isClosedRing = (ring: unknown): ring is number[][] => {
  if (!Array.isArray(ring) || ring.length < 4 || !ring.every(isPosition)) return false
  const first = ring[0]
  const last = ring[ring.length - 1]
  return first[0] === last[0] && first[1] === last[1]
}

const isValidPolygonGeometry = (geometry: unknown): geometry is GeoJSON.Polygon => {
  if (!geometry || typeof geometry !== 'object') return false
  const candidate = geometry as { type?: unknown; coordinates?: unknown }
  return (
    candidate.type === 'Polygon' &&
    Array.isArray(candidate.coordinates) &&
    candidate.coordinates.length > 0 &&
    candidate.coordinates.every(isClosedRing)
  )
}

export const extractSinglePolygonFeature = (geojson: unknown): GeoJSON.Feature<GeoJSON.Polygon> => {
  if (!geojson || typeof geojson !== 'object') {
    throw new Error('GeoJSON must be a Polygon Feature or a FeatureCollection containing one Polygon Feature.')
  }

  const candidate = geojson as {
    type?: unknown
    geometry?: unknown
    properties?: GeoJSON.GeoJsonProperties
    features?: unknown
  }

  if (candidate.type === 'Feature') {
    if (!isValidPolygonGeometry(candidate.geometry)) {
      throw new Error('GeoJSON Feature must contain exactly one Polygon geometry.')
    }
    return {
      type: 'Feature',
      properties: candidate.properties ?? {},
      geometry: candidate.geometry,
    }
  }

  if (candidate.type === 'FeatureCollection') {
    if (!Array.isArray(candidate.features) || candidate.features.length !== 1) {
      throw new Error('GeoJSON FeatureCollection must contain exactly one feature.')
    }
    return extractSinglePolygonFeature(candidate.features[0])
  }

  throw new Error('GeoJSON must be a Polygon Feature or a FeatureCollection containing one Polygon Feature.')
}
