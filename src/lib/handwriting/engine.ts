import wasmUrl from './handwriting_engine.wasm?url';

/** Thin bridge over the Rust handwriting engine (rust/handwriting-engine). */
interface EngineExports {
  memory: WebAssembly.Memory;
  hw_alloc(size: number): number;
  hw_free(ptr: number, size: number): void;
  hw_out_f32_ptr(): number;
  hw_out_f32_len(): number;
  hw_out_u8_ptr(): number;
  hw_out_u8_len(): number;
  hw_prepare_text(ptr: number, len: number, flags: number): number;
  hw_layout(ptr: number, len: number): number;
  hw_render_paper(w: number, h: number, template: number, lineH: number, firstBaseline: number, marginLeft: number, seed: number): number;
  hw_ink_texture(ptr: number, w: number, h: number, pen: number, seed: number, scale: number): void;
  hw_photo_filter(ptr: number, w: number, h: number, strength: number, seed: number): void;
}

export class HandwritingEngine {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();

  constructor(private x: EngineExports) {}

  private withBytes<T>(data: Uint8Array, fn: (ptr: number) => T): T {
    const ptr = this.x.hw_alloc(data.byteLength);
    try {
      new Uint8Array(this.x.memory.buffer, ptr, data.byteLength).set(data);
      return fn(ptr);
    } finally {
      this.x.hw_free(ptr, data.byteLength);
    }
  }

  private outBytes(): Uint8Array {
    const ptr = this.x.hw_out_u8_ptr();
    const len = this.x.hw_out_u8_len();
    return new Uint8Array(this.x.memory.buffer, ptr, len).slice();
  }

  prepareText(text: string, opts: { latex: boolean; markdown: boolean }): string {
    const flags = (opts.latex ? 1 : 0) | (opts.markdown ? 2 : 0);
    const bytes = this.encoder.encode(text);
    if (bytes.byteLength === 0) return '';
    this.withBytes(bytes, (ptr) => this.x.hw_prepare_text(ptr, bytes.byteLength, flags));
    return this.decoder.decode(this.outBytes());
  }

  layout(input: Float32Array): Float32Array {
    const bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    this.withBytes(bytes, (ptr) => this.x.hw_layout(ptr, input.length));
    const ptr = this.x.hw_out_f32_ptr();
    const len = this.x.hw_out_f32_len();
    return new Float32Array(this.x.memory.buffer, ptr, len).slice();
  }

  renderPaper(w: number, h: number, template: number, lineH: number, firstBaseline: number, marginLeft: number, seed: number): ImageData {
    this.x.hw_render_paper(w, h, template, lineH, firstBaseline, marginLeft, seed >>> 0);
    const bytes = this.outBytes();
    return new ImageData(new Uint8ClampedArray(bytes.buffer, bytes.byteOffset, bytes.byteLength), w, h);
  }

  private inPlace(img: ImageData, fn: (ptr: number) => void) {
    const src = new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength);
    const ptr = this.x.hw_alloc(src.byteLength);
    try {
      new Uint8Array(this.x.memory.buffer, ptr, src.byteLength).set(src);
      fn(ptr);
      src.set(new Uint8Array(this.x.memory.buffer, ptr, src.byteLength));
    } finally {
      this.x.hw_free(ptr, src.byteLength);
    }
  }

  inkTexture(img: ImageData, pen: number, seed: number, scale: number) {
    this.inPlace(img, (ptr) => this.x.hw_ink_texture(ptr, img.width, img.height, pen, seed >>> 0, scale));
  }

  photoFilter(img: ImageData, strength: number, seed: number) {
    this.inPlace(img, (ptr) => this.x.hw_photo_filter(ptr, img.width, img.height, strength, seed >>> 0));
  }
}

let pending: Promise<HandwritingEngine> | null = null;

export function loadHandwritingEngine(): Promise<HandwritingEngine> {
  if (!pending) {
    pending = (async () => {
      const response = await fetch(wasmUrl);
      if (!response.ok) throw new Error(`Handwriting engine failed to load (${response.status})`);
      const { instance } = 'instantiateStreaming' in WebAssembly && response.headers.get('content-type')?.includes('wasm')
        ? await WebAssembly.instantiateStreaming(response, {})
        : await WebAssembly.instantiate(await response.arrayBuffer(), {});
      return new HandwritingEngine(instance.exports as unknown as EngineExports);
    })();
    pending.catch(() => { pending = null; });
  }
  return pending;
}
