//! Deterministic randomness: a SplitMix64 stream for sequential decisions and
//! stateless hash noise for per-pixel textures (same seed => same page).

pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn f(&mut self) -> f32 {
        (self.next_u64() >> 40) as f32 / (1u64 << 24) as f32
    }

    /// Uniform in [-1, 1).
    pub fn signed(&mut self) -> f32 {
        self.f() * 2.0 - 1.0
    }

    /// Roughly normal in [-1, 1] (sum of three uniforms) — human variation
    /// clusters around the mean instead of being evenly spread.
    pub fn soft(&mut self) -> f32 {
        (self.signed() + self.signed() + self.signed()) / 3.0
    }

    pub fn range(&mut self, a: f32, b: f32) -> f32 {
        a + (b - a) * self.f()
    }

    pub fn below(&mut self, n: usize) -> usize {
        if n == 0 {
            0
        } else {
            (self.next_u64() % n as u64) as usize
        }
    }
}

#[inline]
pub fn hash2(x: i32, y: i32, seed: u32) -> f32 {
    let mut h = (x as u32).wrapping_mul(0x8DA6_B343)
        ^ (y as u32).wrapping_mul(0xD816_3841)
        ^ seed.wrapping_mul(0xCB1A_B31F);
    h ^= h >> 13;
    h = h.wrapping_mul(0x5BD1_E995);
    h ^= h >> 15;
    (h & 0x00FF_FFFF) as f32 / 16_777_215.0
}

#[inline]
fn smooth(t: f32) -> f32 {
    t * t * (3.0 - 2.0 * t)
}

/// Bilinear value noise in [0, 1] with lattice spacing `cell` pixels.
#[inline]
pub fn value_noise(x: f32, y: f32, cell: f32, seed: u32) -> f32 {
    let fx = x / cell;
    let fy = y / cell;
    let ix = fx.floor();
    let iy = fy.floor();
    let tx = smooth(fx - ix);
    let ty = smooth(fy - iy);
    let (ix, iy) = (ix as i32, iy as i32);
    let a = hash2(ix, iy, seed);
    let b = hash2(ix + 1, iy, seed);
    let c = hash2(ix, iy + 1, seed);
    let d = hash2(ix + 1, iy + 1, seed);
    let top = a + (b - a) * tx;
    let bottom = c + (d - c) * tx;
    top + (bottom - top) * ty
}

/// Fractal noise: `octaves` layers of value noise, each half the cell size.
pub fn fbm(x: f32, y: f32, cell: f32, octaves: u32, seed: u32) -> f32 {
    let mut sum = 0.0;
    let mut amp = 0.5;
    let mut norm = 0.0;
    let mut c = cell;
    for o in 0..octaves {
        sum += value_noise(x, y, c, seed.wrapping_add(o * 977)) * amp;
        norm += amp;
        amp *= 0.5;
        c *= 0.5;
    }
    sum / norm
}
