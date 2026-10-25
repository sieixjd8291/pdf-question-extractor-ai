declare module 'imagetracerjs' {
  interface TraceImage { width: number; height: number; data: Uint8ClampedArray }
  interface TraceData { layers: unknown[][]; palette: unknown[]; width: number; height: number }
  const ImageTracer: {
    imagedataToTracedata(img: TraceImage, options?: Record<string, unknown>): TraceData;
  };
  export default ImageTracer;
}
