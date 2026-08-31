export type GeneratedModelPayload = {
  objUrl: string
  rank?: number
  color?: string
  placement: {
    coords: [number, number]
    rotation: { x: number; y: number; z: number }
    scale: number
    mercatorZScale?: number
    anchor: string
  }
}

export type ModelTransformMetadata = {
  coordinateSpace?: {
    origin_lonlat?: unknown
    mercatorZScale?: unknown
  }
}
