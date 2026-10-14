//! Procedural notebook paper. Rulings are generated from the live layout
//! (line height, first baseline, left margin), so handwriting always sits
//! exactly on the printed lines no matter how the layout is tuned.

use crate::rng::{fbm, hash2, value_noise};

pub const CLASSIC_WHITE: u32 = 0;
pub const RULED: u32 = 1;
pub const SPIRAL: u32 = 2;
pub const GRAPH: u32 = 3;
pub const DOTTED: u32 = 4;
pub const LEGAL: u32 = 5;
pub const PARCHMENT: u32 = 6;
pub const KRAFT: u32 = 7;
pub const EXAM: u32 = 8;
pub const CREAM_RULED: u32 = 9;

struct Style {
    base: [f32; 3],
    grain: f32,
    fiber: f32,
    mottle: f32,
    edge_burn: f32,
}

fn style(template: u32) -> Style {
    match template {
        LEGAL => Style { base: [252.0, 241.0, 166.0], grain: 0.022, fiber: 0.02, mottle: 0.0, edge_burn: 0.0 },
        PARCHMENT => Style { base: [238.0, 224.0, 192.0], grain: 0.045, fiber: 0.03, mottle: 0.13, edge_burn: 0.35 },
        KRAFT => Style { base: [198.0, 166.0, 124.0], grain: 0.07, fiber: 0.09, mottle: 0.06, edge_burn: 0.12 },
        CREAM_RULED => Style { base: [249.0, 243.0, 228.0], grain: 0.024, fiber: 0.02, mottle: 0.02, edge_burn: 0.0 },
        CLASSIC_WHITE => Style { base: [251.0, 251.0, 248.0], grain: 0.018, fiber: 0.014, mottle: 0.0, edge_burn: 0.0 },
        _ => Style { base: [252.0, 252.0, 250.0], grain: 0.02, fiber: 0.016, mottle: 0.0, edge_burn: 0.0 },
    }
}

#[inline]
fn blend(buf: &mut [u8], idx: usize, c: [f32; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let a = a.min(1.0);
    for k in 0..3 {
        let v = buf[idx + k] as f32;
        buf[idx + k] = (v + (c[k] - v) * a).clamp(0.0, 255.0) as u8;
    }
}

/// Anti-aliased coverage of a line of half-width `hw` at distance `d`.
#[inline]
fn coverage(d: f32, hw: f32) -> f32 {
    (hw + 0.5 - d.abs()).clamp(0.0, 1.0)
}

fn hline(buf: &mut [u8], w: u32, h: u32, y: f32, x0: f32, x1: f32, hw: f32, color: [f32; 3], alpha: f32, seed: u32) {
    let ymin = (y - hw - 1.0).floor().max(0.0) as u32;
    let ymax = ((y + hw + 1.0).ceil() as u32).min(h.saturating_sub(1));
    let xa = x0.max(0.0) as u32;
    let xb = (x1.min(w as f32)) as u32;
    for py in ymin..=ymax {
        let cov = coverage(py as f32 + 0.5 - y, hw);
        if cov <= 0.0 {
            continue;
        }
        for px in xa..xb {
            let ink = 0.82 + 0.18 * value_noise(px as f32, y, 9.0, seed);
            blend(buf, ((py * w + px) * 4) as usize, color, alpha * cov * ink);
        }
    }
}

fn vline(buf: &mut [u8], w: u32, h: u32, x: f32, hw: f32, color: [f32; 3], alpha: f32, seed: u32) {
    let xmin = (x - hw - 1.0).floor().max(0.0) as u32;
    let xmax = ((x + hw + 1.0).ceil() as u32).min(w.saturating_sub(1));
    for px in xmin..=xmax {
        let cov = coverage(px as f32 + 0.5 - x, hw);
        if cov <= 0.0 {
            continue;
        }
        for py in 0..h {
            let ink = 0.82 + 0.18 * value_noise(x, py as f32, 9.0, seed);
            blend(buf, ((py * w + px) * 4) as usize, color, alpha * cov * ink);
        }
    }
}

fn disc(buf: &mut [u8], w: u32, h: u32, cx: f32, cy: f32, r: f32, color: [f32; 3], alpha: f32) {
    let x0 = (cx - r - 1.0).max(0.0) as u32;
    let x1 = ((cx + r + 1.0) as u32).min(w.saturating_sub(1));
    let y0 = (cy - r - 1.0).max(0.0) as u32;
    let y1 = ((cy + r + 1.0) as u32).min(h.saturating_sub(1));
    for py in y0..=y1 {
        for px in x0..=x1 {
            let d = ((px as f32 + 0.5 - cx).powi(2) + (py as f32 + 0.5 - cy).powi(2)).sqrt();
            let cov = (r + 0.5 - d).clamp(0.0, 1.0);
            blend(buf, ((py * w + px) * 4) as usize, color, alpha * cov);
        }
    }
}

fn spiral(buf: &mut [u8], w: u32, h: u32, s: f32) {
    let r = 8.5 * s;
    let cx = 34.0 * s;
    let step = 46.0 * s;
    let mut cy = 34.0 * s;
    while cy < h as f32 - 20.0 * s {
        // Soft shadow ring around the punched hole.
        disc(buf, w, h, cx + 1.5 * s, cy + 2.0 * s, r + 3.5 * s, [150.0, 150.0, 150.0], 0.18);
        disc(buf, w, h, cx, cy, r, [48.0, 50.0, 56.0], 0.92);
        disc(buf, w, h, cx - r * 0.25, cy - r * 0.3, r * 0.45, [80.0, 82.0, 90.0], 0.5);
        // Metal coil passing through the hole and over the page edge.
        let (ax, ay) = (cx - r * 0.2, cy + r * 0.15);
        let (bx, by) = (-6.0 * s, cy - 15.0 * s);
        let thick = 4.2 * s;
        let minx = bx.min(ax) - thick;
        let maxx = ax.max(bx) + thick;
        let miny = by.min(ay) - thick;
        let maxy = ay.max(by) + thick;
        let (dx, dy) = (bx - ax, by - ay);
        let len2 = dx * dx + dy * dy;
        for py in (miny.max(0.0) as u32)..((maxy as u32).min(h - 1)) {
            for px in (minx.max(0.0) as u32)..((maxx.max(0.0) as u32).min(w - 1)) {
                let (qx, qy) = (px as f32 + 0.5 - ax, py as f32 + 0.5 - ay);
                let t = ((qx * dx + qy * dy) / len2).clamp(0.0, 1.0);
                let ex = qx - dx * t;
                let ey = qy - dy * t;
                let d = (ex * ex + ey * ey).sqrt();
                if d < thick + 1.0 {
                    let shade = 1.0 - (d / thick).min(1.0);
                    let metal = 120.0 + 115.0 * shade.powf(0.7);
                    let cov = (thick + 0.5 - d).clamp(0.0, 1.0);
                    blend(buf, ((py * w + px) * 4) as usize, [metal, metal, metal + 6.0], cov);
                }
            }
        }
        cy += step;
    }
}

pub fn render(w: u32, h: u32, template: u32, line_h: f32, first_baseline: f32, margin_left: f32, seed: u32) -> Vec<u8> {
    let w = w.max(8);
    let h = h.max(8);
    let s = w as f32 / 1240.0;
    let st = style(template);
    let mut buf = vec![255u8; (w * h * 4) as usize];
    let (fw, fh) = (w as f32, h as f32);
    for y in 0..h {
        let fy = y as f32;
        let ny = fy / fh;
        for x in 0..w {
            let fx = x as f32;
            let nx = fx / fw;
            let fine = hash2(x as i32, y as i32, seed) - 0.5;
            let fiber = value_noise(fx, fy * 0.3, 5.0 * s, seed.wrapping_add(11)) - 0.5;
            let mut k = 1.0 + fine * st.grain + fiber * st.fiber;
            if st.mottle > 0.0 {
                k += (fbm(fx, fy, 210.0 * s, 3, seed.wrapping_add(23)) - 0.5) * st.mottle;
            }
            k *= 1.0 - 0.03 * ((nx - 0.4).powi(2) + (ny - 0.32).powi(2));
            if st.edge_burn > 0.0 {
                let edge = nx.min(1.0 - nx).min(ny.min(1.0 - ny));
                let wobble = (fbm(fx, fy, 60.0 * s, 2, seed.wrapping_add(41)) - 0.5) * 0.04;
                let t = (1.0 - ((edge + wobble) / 0.07).clamp(0.0, 1.0)).powi(2);
                k *= 1.0 - st.edge_burn * t;
            }
            let i = ((y * w + x) * 4) as usize;
            buf[i] = (st.base[0] * k).clamp(0.0, 255.0) as u8;
            buf[i + 1] = (st.base[1] * k).clamp(0.0, 255.0) as u8;
            buf[i + 2] = (st.base[2] * k).clamp(0.0, 255.0) as u8;
            buf[i + 3] = 255;
        }
    }

    let line_h = line_h.max(8.0 * s);
    let rule_offset = 2.0 * s;
    let top = (line_h * 1.1).max(fh * 0.05);
    let ruled_rows = || {
        let mut rows = Vec::new();
        let mut y = first_baseline + rule_offset;
        while y - line_h >= top {
            y -= line_h;
        }
        while y < fh - line_h * 0.35 {
            rows.push(y);
            y += line_h;
        }
        rows
    };
    let blue = [118.0, 158.0, 214.0];
    let red = [222.0, 86.0, 92.0];
    let margin_x = margin_left - 16.0 * s;

    match template {
        RULED | SPIRAL | EXAM | CREAM_RULED => {
            for y in ruled_rows() {
                hline(&mut buf, w, h, y, 0.0, fw, 0.7 * s, blue, 0.6, seed.wrapping_add(3));
            }
            if template != CREAM_RULED && margin_x > 6.0 * s {
                vline(&mut buf, w, h, margin_x, 0.8 * s, red, 0.62, seed.wrapping_add(5));
                if template == EXAM {
                    vline(&mut buf, w, h, margin_x - 6.0 * s, 0.6 * s, red, 0.5, seed.wrapping_add(6));
                    let header = (first_baseline - line_h * 1.35).max(top * 0.6);
                    hline(&mut buf, w, h, header, 0.0, fw, 0.8 * s, red, 0.6, seed.wrapping_add(7));
                    hline(&mut buf, w, h, header - 5.0 * s, 0.0, fw, 0.6 * s, red, 0.5, seed.wrapping_add(8));
                }
            }
            if template == SPIRAL {
                spiral(&mut buf, w, h, s);
            }
        }
        LEGAL => {
            for y in ruled_rows() {
                hline(&mut buf, w, h, y, 0.0, fw, 0.7 * s, [110.0, 150.0, 196.0], 0.5, seed.wrapping_add(3));
            }
            if margin_x > 10.0 * s {
                vline(&mut buf, w, h, margin_x, 0.75 * s, red, 0.6, seed.wrapping_add(5));
                vline(&mut buf, w, h, margin_x - 6.0 * s, 0.75 * s, red, 0.6, seed.wrapping_add(6));
            }
        }
        GRAPH => {
            let g = line_h / 2.0;
            let mut y = (first_baseline + rule_offset) % g;
            let mut row = ((first_baseline + rule_offset - y) / g).round() as i32;
            while y < fh {
                let major = row % 2 == 0;
                hline(&mut buf, w, h, y, 0.0, fw, if major { 0.65 * s } else { 0.45 * s }, [128.0, 176.0, 190.0], if major { 0.42 } else { 0.24 }, seed.wrapping_add(3));
                y += g;
                row += 1;
            }
            let mut x = margin_left % g;
            let mut col = ((margin_left - x) / g).round() as i32;
            while x < fw {
                let major = col % 2 == 0;
                vline(&mut buf, w, h, x, if major { 0.65 * s } else { 0.45 * s }, [128.0, 176.0, 190.0], if major { 0.42 } else { 0.24 }, seed.wrapping_add(4));
                x += g;
                col += 1;
            }
        }
        DOTTED => {
            let g = line_h / 2.0;
            let mut y = (first_baseline + rule_offset) % g;
            while y < fh {
                let mut x = margin_left % g;
                while x < fw {
                    disc(&mut buf, w, h, x, y, 1.3 * s, [150.0, 160.0, 175.0], 0.55);
                    x += g;
                }
                y += g;
            }
        }
        _ => {}
    }
    buf
}
