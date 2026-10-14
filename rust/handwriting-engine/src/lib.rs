//! Assignment Maker engine, compiled to WebAssembly with a plain C ABI (no
//! bindgen): the host allocates input in linear memory, calls an entry point,
//! then copies the result out via `hw_out_*` before the next call.

pub mod filters;
pub mod layout;
pub mod paper;
pub mod rng;
pub mod text;

use std::alloc::{alloc, dealloc, Layout};
use std::cell::RefCell;

thread_local! {
    static OUT_F32: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
    static OUT_U8: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

fn layout_for(size: usize) -> Layout {
    Layout::from_size_align(size.max(8), 8).expect("valid layout")
}

#[no_mangle]
pub extern "C" fn hw_alloc(size: usize) -> *mut u8 {
    unsafe { alloc(layout_for(size)) }
}

/// # Safety
/// `ptr` must come from `hw_alloc(size)` with the same `size`.
#[no_mangle]
pub unsafe extern "C" fn hw_free(ptr: *mut u8, size: usize) {
    if !ptr.is_null() {
        dealloc(ptr, layout_for(size));
    }
}

#[no_mangle]
pub extern "C" fn hw_out_f32_ptr() -> *const f32 {
    OUT_F32.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn hw_out_f32_len() -> usize {
    OUT_F32.with(|o| o.borrow().len())
}

#[no_mangle]
pub extern "C" fn hw_out_u8_ptr() -> *const u8 {
    OUT_U8.with(|o| o.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn hw_out_u8_len() -> usize {
    OUT_U8.with(|o| o.borrow().len())
}

#[no_mangle]
pub extern "C" fn hw_version() -> u32 {
    1
}

/// Prepare UTF-8 text. flags: bit 0 = LaTeX math, bit 1 = markdown cleanup.
/// Result (UTF-8) in the u8 output buffer; returns its byte length.
///
/// # Safety
/// `ptr..ptr+len` must be readable linear memory.
#[no_mangle]
pub unsafe extern "C" fn hw_prepare_text(ptr: *const u8, len: usize, flags: u32) -> usize {
    let bytes = std::slice::from_raw_parts(ptr, len);
    let input = String::from_utf8_lossy(bytes);
    let out = text::prepare(&input, flags & 1 != 0, flags & 2 != 0);
    let n = out.len();
    OUT_U8.with(|o| *o.borrow_mut() = out.into_bytes());
    n
}

/// Run the layout engine on `len` f32 values. Result in the f32 output buffer.
///
/// # Safety
/// `ptr` must point to `len` aligned f32 values.
#[no_mangle]
pub unsafe extern "C" fn hw_layout(ptr: *const f32, len: usize) -> usize {
    let input = std::slice::from_raw_parts(ptr, len);
    let res = layout::run(input);
    let mut out = Vec::with_capacity(3 + res.glyphs.len() + res.strokes.len());
    out.push(res.pages as f32);
    out.push(res.glyph_count as f32);
    out.push(res.stroke_count as f32);
    out.extend_from_slice(&res.glyphs);
    out.extend_from_slice(&res.strokes);
    let n = out.len();
    OUT_F32.with(|o| *o.borrow_mut() = out);
    n
}

/// Render a paper template as RGBA into the u8 output buffer.
#[no_mangle]
pub extern "C" fn hw_render_paper(w: u32, h: u32, template: u32, line_h: f32, first_baseline: f32, margin_left: f32, seed: u32) -> usize {
    let buf = paper::render(w, h, template, line_h, first_baseline, margin_left, seed);
    let n = buf.len();
    OUT_U8.with(|o| *o.borrow_mut() = buf);
    n
}

/// # Safety
/// `ptr` must point to `w*h*4` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn hw_ink_texture(ptr: *mut u8, w: u32, h: u32, pen: u32, seed: u32, scale: f32) {
    let buf = std::slice::from_raw_parts_mut(ptr, (w * h * 4) as usize);
    filters::ink_texture(buf, w, h, pen, seed, scale);
}

/// # Safety
/// `ptr` must point to `w*h*4` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn hw_photo_filter(ptr: *mut u8, w: u32, h: u32, strength: f32, seed: u32) {
    let buf = std::slice::from_raw_parts_mut(ptr, (w * h * 4) as usize);
    filters::photo_filter(buf, w, h, strength, seed);
}
