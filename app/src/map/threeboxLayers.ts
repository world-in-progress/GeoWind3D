import type { CustomLayerInterface, Map as MapboxMap } from 'mapbox-gl'
import initTileset from '../utils/3dtilesLayer.js'
import type { GeneratedModelPayload } from '../types/modelPayload'

export type ObjLayerOptions = {
  wireframe?: boolean
  wireframeColor?: string
  polygonOffset?: boolean
  polygonOffsetFactor?: number
  polygonOffsetUnits?: number
  emissiveStrength?: number
  emissiveIntensity?: number
  specularColor?: string
  shininess?: number
}

type ThreeboxLayerExtension = CustomLayerInterface & {
  tb?: {
    update: () => void
  }
}

type ObjLayerController = {
  replaceModel: (model: GeneratedModelPayload) => void
  clearModel: () => void
}

const objLayerControllers = new WeakMap<MapboxMap, Map<string, ObjLayerController>>()

const getObjLayerControllers = (map: MapboxMap) => {
  let controllers = objLayerControllers.get(map)
  if (!controllers) {
    controllers = new Map<string, ObjLayerController>()
    objLayerControllers.set(map, controllers)
  }
  return controllers
}

const applyGeneratedModelStyle = (
  modelObject: any,
  color: string,
  opacity: number,
  options?: ObjLayerOptions,
) => {
  const three = window.THREE
  if (!modelObject || !three?.DoubleSide) return

  const modelColor = new three.Color(color)

  const toLitMaterial = (material: any) => {
    if (!material) return material

    if (typeof three.MeshPhongMaterial === 'function') {
      const phong = new three.MeshPhongMaterial({
        color: modelColor.clone(),
        emissive: modelColor.clone().multiplyScalar(options?.emissiveStrength ?? 0.18),
        emissiveIntensity: options?.emissiveIntensity ?? 0.25,
        specular: new three.Color(options?.specularColor ?? '#444444'),
        shininess: options?.shininess ?? 10,
        map: null,
        transparent: opacity < 1,
        opacity: opacity,
        side: three.DoubleSide,
        depthWrite: true,
      })
      if (options?.polygonOffset) {
        phong.polygonOffset = true
        phong.polygonOffsetFactor = options.polygonOffsetFactor ?? 1
        phong.polygonOffsetUnits = options.polygonOffsetUnits ?? 1
      }
      phong.toneMapped = false
      phong.needsUpdate = true
      return phong
    }

    if (typeof three.MeshLambertMaterial === 'function') {
      const lambert = new three.MeshLambertMaterial({
        color: modelColor.clone(),
        emissive: modelColor.clone().multiplyScalar(options?.emissiveStrength ?? 0.18),
        emissiveIntensity: options?.emissiveIntensity ?? 0.25,
        map: null,
        transparent: opacity < 1,
        opacity: opacity,
        side: three.DoubleSide,
        depthWrite: true,
      })
      if (options?.polygonOffset) {
        lambert.polygonOffset = true
        lambert.polygonOffsetFactor = options.polygonOffsetFactor ?? 1
        lambert.polygonOffsetUnits = options.polygonOffsetUnits ?? 1
      }
      lambert.toneMapped = false
      lambert.needsUpdate = true
      return lambert
    }

    material.map = null
    material.color = modelColor.clone()
    material.transparent = opacity < 1
    material.opacity = opacity
    material.side = three.DoubleSide
    material.depthWrite = true
    material.wireframe = false
    material.toneMapped = false
    if (options?.polygonOffset) {
      material.polygonOffset = true
      material.polygonOffsetFactor = options.polygonOffsetFactor ?? 1
      material.polygonOffsetUnits = options.polygonOffsetUnits ?? 1
    }
    material.needsUpdate = true
    return material
  }

  modelObject.traverse((node: any) => {
    if (!node?.isMesh || !node.material) return
    if (node.geometry?.computeVertexNormals) {
      node.geometry.computeVertexNormals()
    }
    if (Array.isArray(node.material)) {
      node.material = node.material.map((mat: any) => toLitMaterial(mat))
    } else {
      node.material = toLitMaterial(node.material)
    }
    node.castShadow = false
    node.receiveShadow = true
  })
}

const addPublicationModelLights = (scene: any) => {
  const three = window.THREE
  if (!scene || !three?.AmbientLight || !three?.DirectionalLight) return

  const ambient = new three.AmbientLight(0xffffff, 0.22)
  ambient.name = 'publication-model-ambient-light'
  scene.add(ambient)

  const keyLight = new three.DirectionalLight(0xffffff, 1.0)
  keyLight.name = 'publication-model-key-light'
  keyLight.position.set(-0.8, -0.55, 0.9)
  scene.add(keyLight)

  const fillLight = new three.DirectionalLight(0xffffff, 0.16)
  fillLight.name = 'publication-model-fill-light'
  fillLight.position.set(0.6, 0.25, 0.7)
  scene.add(fillLight)
}

const addModelWireframe = (modelObject: any, color = '#166534') => {
  const three = window.THREE
  if (!modelObject || !three?.WireframeGeometry || !three?.LineSegments || !three?.LineBasicMaterial) return

  const lineMaterial = new three.LineBasicMaterial({
    color: new three.Color(color),
    transparent: true,
    opacity: 0.9,
    depthTest: true,
    depthWrite: false,
  })

  modelObject.traverse((node: any) => {
    if (!node?.isMesh || !node.geometry) return

    const wireGeometry = new three.WireframeGeometry(node.geometry)
    const wireframe = new three.LineSegments(wireGeometry, lineMaterial)
    wireframe.name = 'terrain-wireframe-overlay'
    wireframe.renderOrder = 1
    node.add(wireframe)
  })
}

const disposeLoadedObject = (modelObject: any) => {
  modelObject?.traverse?.((node: any) => {
    node.geometry?.dispose?.()
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    materials.forEach((material: any) => {
      material?.map?.dispose?.()
      material?.dispose?.()
    })
  })
}

const removeLabelRendererElement = (tb: any) => {
  const element = tb?.labelRenderer?.renderer?.domElement
  element?.parentNode?.removeChild(element)
}

const isValidModelPlacement = (model: GeneratedModelPayload) => {
  const placement = model.placement
  if (
    !placement ||
    !Array.isArray(placement.coords) ||
    placement.coords.length !== 2 ||
    placement.coords.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    console.error('Model placement.coords is missing or invalid', model)
    return false
  }
  if (
    !placement.rotation ||
    typeof placement.rotation.x !== 'number' ||
    !Number.isFinite(placement.rotation.x) ||
    typeof placement.rotation.y !== 'number' ||
    !Number.isFinite(placement.rotation.y) ||
    typeof placement.rotation.z !== 'number' ||
    !Number.isFinite(placement.rotation.z)
  ) {
    console.error('Model placement.rotation is missing or invalid', model)
    return false
  }
  if (typeof placement.scale !== 'number' || !Number.isFinite(placement.scale)) {
    console.error('Model placement.scale is missing or invalid', model)
    return false
  }
  if (typeof placement.anchor !== 'string' || placement.anchor.trim() === '') {
    console.error('Model placement.anchor is missing or invalid', model)
    return false
  }
  return true
}

export const loadThreeboxTilesLayer = (
  map: MapboxMap,
  sources: string | string[],
  layerId: string,
  beforeId?: string,
  onLayerAdded?: () => void,
) => {
  if (!window.Threebox) {
    console.error('Threebox plugin is not available on window.Threebox')
    return
  }

  const sourceList = (Array.isArray(sources) ? sources : [sources]).map((source) =>
    new URL(source, window.location.origin).toString()
  )

  if (map.getLayer(layerId)) {
    map.removeLayer(layerId)
  }

  const customLayer: CustomLayerInterface = {
    id: layerId,
    type: 'custom',
    renderingMode: '3d',
    onAdd: (mapInstance, gl) => {
      if (!window.Threebox) return

      const tb = new window.Threebox(mapInstance, gl, {
        defaultLights: true,
        enableSelectingObjects: false,
        enableDraggingObjects: false,
        multiLayer: true,
      })

      const world = new window.THREE.Group()
      world.name = '3dtiles_World'
      tb.scene.add(world)

      sourceList.forEach((url) => {
        const tileNode = initTileset(mapInstance, world, tb.renderer, url)
        world.add(tileNode)
      })

      ;(customLayer as ThreeboxLayerExtension).tb = tb
    },
    render: () => {
      const ext = customLayer as ThreeboxLayerExtension
      ext.tb?.update()
    },
    onRemove: () => {
      const ext = customLayer as ThreeboxLayerExtension
      removeLabelRendererElement(ext.tb)
      ext.tb = undefined
    },
  }

  if (beforeId) {
    map.addLayer(customLayer, beforeId)
  } else {
    map.addLayer(customLayer)
  }

  onLayerAdded?.()
}

export const loadObjModelLayer = (
  map: MapboxMap,
  model: GeneratedModelPayload,
  layerId: string,
  color: string,
  opacity: number,
  visible: boolean,
  beforeId?: string,
  options?: ObjLayerOptions,
  onLayerAdded?: () => void,
) => {
  if (!window.Threebox) {
    console.error('Threebox plugin is not available on window.Threebox')
    return
  }

  if (!isValidModelPlacement(model)) return
  const controllers = getObjLayerControllers(map)
  const existingController = controllers.get(layerId)
  if (map.getLayer(layerId) && existingController) {
    existingController.replaceModel(model)
    map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
    onLayerAdded?.()
    return
  }
  if (map.getLayer(layerId)) map.removeLayer(layerId)

  let currentModel = model
  let tb: any = null
  let loadedModel: any = null
  let disposed = false
  let loadVersion = 0

  const clearModel = () => {
    loadVersion += 1
    if (!loadedModel) return
    if (tb?.remove) {
      tb.remove(loadedModel)
    } else {
      disposeLoadedObject(loadedModel)
    }
    loadedModel = null
  }

  const loadCurrentModel = () => {
    if (!tb || disposed) return
    const requestVersion = ++loadVersion
    const placement = currentModel.placement
    const modelUrl = new URL(currentModel.objUrl, window.location.origin).toString()

    tb.loadObj(
      {
        type: 'mtl',
        obj: modelUrl,
        units: 'meters',
        scale: placement.scale,
        rotation: placement.rotation,
        anchor: placement.anchor,
      },
      (nextModel: any) => {
        if (disposed || requestVersion !== loadVersion) {
          disposeLoadedObject(nextModel)
          return
        }
        if (loadedModel) tb.remove(loadedModel)
        nextModel.setCoords(placement.coords)
        if (placement.mercatorZScale && placement.mercatorZScale !== 1) {
          const scale = nextModel.scale
          nextModel.scale.set(scale.x, scale.y, scale.z * placement.mercatorZScale)
        }
        applyGeneratedModelStyle(nextModel, color, opacity, options)
        if (options?.wireframe) addModelWireframe(nextModel, options.wireframeColor)
        loadedModel = nextModel
        tb.add(nextModel, layerId)
      },
    )
  }

  const controller: ObjLayerController = {
    replaceModel: (nextModel) => {
      if (!isValidModelPlacement(nextModel)) return
      currentModel = nextModel
      clearModel()
      loadCurrentModel()
    },
    clearModel,
  }
  controllers.set(layerId, controller)

  const customLayer: CustomLayerInterface = {
    id: layerId,
    type: 'custom',
    renderingMode: '3d',
    onAdd: (mapInstance, gl) => {
      if (!window.Threebox) return
      disposed = false

      tb = new window.Threebox(mapInstance, gl, {
        defaultLights: false,
        enableSelectingObjects: false,
        enableDraggingObjects: false,
        multiLayer: true,
      })
      addPublicationModelLights(tb.scene)
      ;(customLayer as ThreeboxLayerExtension).tb = tb
      loadCurrentModel()
    },
    render: () => {
      const ext = customLayer as ThreeboxLayerExtension
      ext.tb?.update()
    },
    onRemove: () => {
      disposed = true
      clearModel()
      const ext = customLayer as ThreeboxLayerExtension
      removeLabelRendererElement(tb)
      ext.tb = undefined
      tb = null
      controllers.delete(layerId)
    },
  }

  if (beforeId) {
    map.addLayer(customLayer, beforeId)
  } else {
    map.addLayer(customLayer)
  }

  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none')
  onLayerAdded?.()
}

export const clearObjModelLayer = (map: MapboxMap, layerId: string) => {
  getObjLayerControllers(map).get(layerId)?.clearModel()
}
