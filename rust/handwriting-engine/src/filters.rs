//! In-place RGBA effects: pen-specific ink texture on the transparent ink
//! layer, and the "realistic photo" look for finished pages.

use crate::rng::{hash2, value_noise};

pub const PEN_BALLPOINT: u32 = 0;
pub const PEN_GEL: u32 = 1;
pub const PEN_FOUNTAIN: u32 = 2;
pub const PEN_PENCIL: u32 = 3;

/// Modulates ink alpha so strokes read as a physical pen: ballpoint roller
/// skips and paste grain, gel saturation, fountain pooling, graphite tooth.
pub fn ink_texture(buf: &mut [u8], w: u32, h: u32, pen: u32, seed: u32, scale: f32) {
    let s = scale.max(0.25);
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize + 3;
            let a = buf[i];
            if a == 0 {
                continue;
            }
            let (fx, fy) = (x as f32, y as f32);
            let hf = hash2(x as i32, y as i32, seed);
            let factor = match pen {
                PEN_GEL => 1.12 - 0.07 * hf,
                PEN_FOUNTAIN => {
                    let pool = value_noise(fx, fy, 34.0 * s, seed.wrapping_add(9));
                    let mid = value_noise(fx, fy, 3.0 * s, seed.wrapping_add(5));
                    0.7 + 0.42 * pool + 0.1 * (mid - 0.5)
                }
                PEN_PENCIL => {
                    let tooth = value_noise(fx, fy, 1.6 * s, seed.wrapping_add(13));
                    let pressure = value_noise(fx, fy, 28.0 * s, seed.wrapping_add(17));
                    (0.25 + 0.75 * tooth.powf(0.8)) * (0.75 + 0.3 * pressure) * (0.8 + 0.2 * hf)
                }
                _ => {
                    let mid = value_noise(fx, fy, 2.4 * s, seed.wrapping_add(5));
                    let pressure = value_noise(fx, fy, 40.0 * s, seed.wrapping_add(19));
                    let skip = if hf > 0.972 { 0.4 } else { 1.0 };
                    (0.8 + 0.22 * mid + 0.12 * (pressure - 0.5)) * skip
                }
            };
            let mut v = a as f32 * factor;
            if pen == PEN_GEL {
                v = 255.0 * (v / 255.0).powf(0.85);
            }
            buf[i] = v.clamp(0.0, 255.0) as u8;
        }
    }
}

/// Phone-photo look: warm ambient light, off-centre falloff, a soft hand
/// shadow from one corner and sensor grain.
pub fn photo_filter(buf: &mut [u8], w: u32, h: u32, strength: f32, seed: u32) {
    let k = strength.clamp(0.0, 1.0);
    if k == 0.0 {
        return;
    }
    let (fw, fh) = (w as f32, h as f32);
    let light_x = 0.3 + 0.2 * hash2(1, 2, seed);
    let light_y = 0.25 + 0.15 * hash2(3, 4, seed);
    for y in 0..h {
        let ny = y as f32 / fh;
        for x in 0..w {
            let nx = x as f32 / fw;
            let d2 = (nx - light_x).powi(2) + (ny - light_y).powi(2) * 0.8;
            let falloff = 1.0 - k * 0.32 * d2;
            let corner = nx * 0.55 + ny * 0.45;
            let shadow = 1.0 - k * 0.16 * ((corner - 0.62) / 0.38).clamp(0.0, 1.0).powi(2);
            let grain = (hash2(x as i32, y as i32, seed.wrapping_add(77)) - 0.5) * 16.0 * k;
            let lum = falloff * shadow;
            let i = ((y * w + x) * 4) as usize;
            let warm = [1.0 + 0.04 * k, 1.0 + 0.012 * k, 1.0 - 0.06 * k];
            for c in 0..3 {
                let v = buf[i + c] as f32;
                let v = 128.0 + (v - 128.0) * (1.0 - 0.07 * k);
                buf[i + c] = (v * lum * warm[c] + grain).clamp(0.0, 255.0) as u8;
            }
        }
    }
}
