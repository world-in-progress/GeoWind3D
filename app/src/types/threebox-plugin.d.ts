interface Window {
  THREE: any
  threedtiles: any
  Threebox?: new (
    map: any,
    glContext: WebGLRenderingContext | WebGL2RenderingContext,
    options?: Record<string, unknown>
  ) => {
    scene: any
    renderer: any
    update: () => void
    add: (obj: any) => void
    loadObj: (
      options: Record<string, unknown>,
      cb: (obj: any) => void
    ) => Promise<any> | void
  }
}
declare module '*.js' {
  const value: any
  export default value
}
