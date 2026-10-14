//! Handwriting layout: word wrap, pagination, alignment, organic per-glyph
//! variation, auto-mistakes (typo + cross-out + correction) and heading
//! underlines. Works on opaque "unit" ids (grapheme clusters measured by the
//! host), so complex scripts keep their shaping.
//!
//! Input (f32 stream):
//!   [PARAM_COUNT params]
//!   [unit_count] then per unit: width_font_a, width_font_b, ascii_code
//!   [seq_count]  then unit ids (negative ids are control tokens)
//!   [override_count] then per override: page, ml, mr, mt, mb, line_height
//! Widths are measured at 100px.
//!
//! Output (f32 stream):
//!   [page_count, glyph_count, stroke_count]
//!   glyph_count x [page, unit, x, y, rotation, scale, font, opacity, skew, flags]
//!   stroke_count x [page, kind, point_count, (x, y) * point_count]

use crate::rng::Rng;

pub const T_SPACE: i32 = -1;
pub const T_NEWLINE: i32 = -2;
pub const T_PAGE: i32 = -3;
pub const T_SUP: i32 = -4;
pub const T_SUB: i32 = -5;
pub const T_END: i32 = -6;
pub const T_HEADING: i32 = -7;

pub const PARAM_COUNT: usize = 32;
pub const GLYPH_STRIDE: usize = 10;

pub const STROKE_STRIKE: f32 = 0.0;
pub const STROKE_WAVY: f32 = 2.0;
pub const STROKE_SCRIBBLE: f32 = 3.0;
pub const STROKE_UNDERLINE: f32 = 4.0;
pub const STROKE_CARET: f32 = 5.0;

const FLAG_MISTAKE: f32 = 1.0;
const FLAG_HEADING: f32 = 2.0;
/// The correct letter traced over a wrong one (drawn heavier by the host).
const FLAG_OVERWRITE: f32 = 4.0;
/// The wrong letter underneath an overwrite.
const FLAG_OVERWRITTEN: f32 = 8.0;
/// A forgotten letter squeezed in above a caret.
const FLAG_INSERT: f32 = 16.0;

/// Mistake kinds (bit mask in param 30).
const MK_CROSS_OUT: u32 = 1;
const MK_CARET: u32 = 2;
const MK_OVERWRITE: u32 = 4;

#[derive(Clone, Copy)]
struct Params {
    page_w: f32,
    page_h: f32,
    font_size: f32,
    letter_spacing: f32,
    word_spacing: f32,
    tilt: f32,
    char_variance: f32,
    baseline_wobble: f32,
    mistake_rate: f32,
    cross_style: i32,
    align: i32,
    seed: u64,
    font_mix: f32,
    indent: f32,
    size_variance: f32,
    line_slope: f32,
    opacity: f32,
    ink_variance: f32,
    margin_jitter: f32,
    has_font_b: bool,
    space_w: [f32; 2],
    heading_scale: f32,
    underline_headings: bool,
    max_pages: usize,
    mistake_mask: u32,
    mistake_seed: u64,
}

#[derive(Clone, Copy)]
struct Geom {
    ml: f32,
    mr: f32,
    mt: f32,
    mb: f32,
    line_h: f32,
}

#[derive(Clone, Copy)]
struct Unit {
    w: [f32; 2],
    ascii: u8,
}

#[derive(Clone, Copy)]
struct Glyph {
    unit: i32,
    font: u8,
    adv: f32,
    scale: f32,
    script: i8,
}

#[derive(Clone)]
struct Word {
    glyphs: Vec<Glyph>,
    width: f32,
    mistake: bool,
    heading: bool,
    /// Missing letter written above a caret: (glyph index it belongs before, unit, drawn width).
    insert: Option<(usize, i32, f32)>,
    /// Glyph index that was first written as the wrong unit, then traced over.
    overwrite: Option<(usize, i32)>,
}

impl Word {
    fn empty_like(w: &Word) -> Word {
        Word { glyphs: Vec::new(), width: 0.0, mistake: w.mistake, heading: w.heading, insert: None, overwrite: None }
    }
}

enum Tok {
    Word(Word),
    Space(f32),
    Newline,
    Page,
}

struct RawWord {
    units: Vec<(i32, i8)>,
    heading: bool,
}

enum RawTok {
    Word(RawWord),
    Space(bool),
    Newline,
    Page,
}

pub struct Output {
    pub pages: usize,
    pub glyphs: Vec<f32>,
    pub strokes: Vec<f32>,
    pub glyph_count: usize,
    pub stroke_count: usize,
}

struct Reader<'a> {
    d: &'a [f32],
    i: usize,
}

impl<'a> Reader<'a> {
    fn next(&mut self) -> f32 {
        let v = self.d.get(self.i).copied().unwrap_or(0.0);
        self.i += 1;
        v
    }
}

pub fn run(input: &[f32]) -> Output {
    let mut r = Reader { d: input, i: 0 };
    let mut p = [0f32; PARAM_COUNT];
    for v in p.iter_mut() {
        *v = r.next();
    }
    let params = Params {
        page_w: p[0].max(100.0),
        page_h: p[1].max(100.0),
        font_size: p[7].max(4.0),
        letter_spacing: p[8],
        word_spacing: p[9],
        tilt: p[10].to_radians(),
        char_variance: p[11].clamp(0.0, 1.0),
        baseline_wobble: p[12].max(0.0),
        mistake_rate: p[13].clamp(0.0, 0.25),
        cross_style: p[14] as i32,
        align: p[15] as i32,
        seed: p[16] as u64,
        font_mix: p[17].clamp(0.0, 1.0),
        indent: p[18].max(0.0),
        size_variance: p[19].clamp(0.0, 1.0),
        line_slope: p[20].max(0.0).to_radians(),
        opacity: p[21].clamp(0.05, 1.0),
        ink_variance: p[22].clamp(0.0, 1.0),
        margin_jitter: p[23].max(0.0),
        has_font_b: p[24] > 0.5,
        space_w: [p[25].max(1.0), p[26].max(1.0)],
        heading_scale: if p[27] > 0.0 { p[27] } else { 1.12 },
        underline_headings: p[28] > 0.5,
        max_pages: if p[29] >= 1.0 { p[29] as usize } else { 200 },
        mistake_mask: if p[30] >= 1.0 { (p[30] as u32) & 7 } else { MK_CROSS_OUT },
        mistake_seed: p[31].max(0.0) as u64,
    };
    let base_geom = Geom { ml: p[2], mr: p[3], mt: p[4], mb: p[5], line_h: p[6].max(params.font_size * 0.5) };

    let unit_count = r.next().max(0.0) as usize;
    let mut units = Vec::with_capacity(unit_count);
    let mut ascii_map = [-1i32; 128];
    for id in 0..unit_count {
        let wa = r.next();
        let wb = r.next();
        let ascii = r.next() as u32;
        let ascii = if ascii < 128 { ascii as u8 } else { 0 };
        if ascii > 0 && ascii_map[ascii as usize] < 0 {
            ascii_map[ascii as usize] = id as i32;
        }
        units.push(Unit { w: [wa, if wb > 0.0 { wb } else { wa }], ascii });
    }
    let seq_count = r.next().max(0.0) as usize;
    let mut seq = Vec::with_capacity(seq_count);
    for _ in 0..seq_count {
        seq.push(r.next() as i32);
    }
    let ov_count = r.next().max(0.0) as usize;
    let mut overrides: Vec<(usize, Geom)> = Vec::with_capacity(ov_count);
    for _ in 0..ov_count {
        let page = r.next() as usize;
        let g = Geom { ml: r.next(), mr: r.next(), mt: r.next(), mb: r.next(), line_h: r.next() };
        overrides.push((page, Geom { line_h: g.line_h.max(params.font_size * 0.5), ..g }));
    }

    let mut rng = Rng::new(params.seed.wrapping_mul(2654435761).wrapping_add(17));
    let raw = tokenize(&seq);
    let tokens = build_tokens(raw, &units, &ascii_map, &params, &mut rng);
    let mut engine = Engine {
        p: params,
        base: base_geom,
        overrides,
        rng,
        out: Output { pages: 1, glyphs: Vec::new(), strokes: Vec::new(), glyph_count: 0, stroke_count: 0 },
        page: 0,
        baseline: 0.0,
        geom: base_geom,
    };
    engine.geom = engine.geom_for(0);
    engine.baseline = engine.geom.mt;
    engine.layout(tokens);
    engine.out
}

fn tokenize(seq: &[i32]) -> Vec<RawTok> {
    let mut out = Vec::new();
    let mut cur: Vec<(i32, i8)> = Vec::new();
    let mut script: i8 = 0;
    let mut heading = false;
    let flush = |cur: &mut Vec<(i32, i8)>, out: &mut Vec<RawTok>, heading: bool| {
        if !cur.is_empty() {
            out.push(RawTok::Word(RawWord { units: std::mem::take(cur), heading }));
        }
    };
    for &u in seq {
        match u {
            T_SPACE => {
                flush(&mut cur, &mut out, heading);
                out.push(RawTok::Space(heading));
            }
            T_NEWLINE => {
                flush(&mut cur, &mut out, heading);
                out.push(RawTok::Newline);
                heading = false;
                script = 0;
            }
            T_PAGE => {
                flush(&mut cur, &mut out, heading);
                out.push(RawTok::Page);
                heading = false;
            }
            T_SUP => script = 1,
            T_SUB => script = -1,
            T_END => script = 0,
            T_HEADING => heading = true,
            id if id >= 0 => cur.push((id, script)),
            _ => {}
        }
    }
    flush(&mut cur, &mut out, heading);
    out
}

const KEY_ROWS: [&[u8]; 3] = [b"qwertyuiop", b"asdfghjkl", b"zxcvbnm"];

fn neighbor_key(ch: u8, rng: &mut Rng) -> u8 {
    let lower = ch.to_ascii_lowercase();
    for row in KEY_ROWS {
        if let Some(pos) = row.iter().position(|&k| k == lower) {
            let pick = if pos == 0 {
                row[1]
            } else if pos == row.len() - 1 {
                row[pos - 1]
            } else if rng.f() < 0.5 {
                row[pos - 1]
            } else {
                row[pos + 1]
            };
            return if ch.is_ascii_uppercase() { pick.to_ascii_uppercase() } else { pick };
        }
    }
    ch
}

/// A believable slip: wrong neighbouring key, swapped pair, dropped or
/// doubled letter, or an abandoned half-word. Returns None when the word
/// cannot be misspelled with glyphs the host measured.
fn letter_positions(word: &RawWord, units: &[Unit]) -> Vec<usize> {
    word.units
        .iter()
        .enumerate()
        .filter(|(_, (u, s))| *s == 0 && units.get(*u as usize).map(|x| x.ascii.is_ascii_alphabetic()).unwrap_or(false))
        .map(|(i, _)| i)
        .collect()
}

/// Only plain, mostly-alphabetic words get mistakes (skips numbers, symbols, maths).
fn is_mistake_candidate(word: &RawWord, units: &[Unit], min_letters: usize) -> bool {
    let letters = letter_positions(word, units).len();
    letters >= min_letters && letters * 10 >= word.units.len() * 8
}

fn make_typo(word: &RawWord, units: &[Unit], ascii_map: &[i32; 128], rng: &mut Rng) -> Option<Vec<(i32, i8)>> {
    let letters = letter_positions(word, units);
    if letters.len() < 3 {
        return None;
    }
    let mut t = word.units.clone();
    for _ in 0..4 {
        // Weighted: abandoned half-words and neighbour keys are the most common slips.
        let kind = match rng.below(10) {
            0..=2 => 0,
            3 | 4 => 1,
            5 => 2,
            6 => 3,
            _ => 4,
        };
        match kind {
            0 => {
                let idx = letters[1 + rng.below(letters.len() - 1)];
                let ch = units[t[idx].0 as usize].ascii;
                let repl = neighbor_key(ch, rng);
                let id = ascii_map[repl as usize];
                if id >= 0 && repl != ch {
                    t[idx].0 = id;
                    return Some(t);
                }
            }
            1 => {
                let k = 1 + rng.below(letters.len() - 2);
                let (a, b) = (letters[k], letters[k + 1]);
                if b == a + 1 && t[a].0 != t[b].0 {
                    t.swap(a, b);
                    return Some(t);
                }
            }
            2 => {
                let idx = letters[1 + rng.below(letters.len() - 1)];
                t.remove(idx);
                return Some(t);
            }
            3 => {
                let idx = letters[rng.below(letters.len())];
                let g = t[idx];
                t.insert(idx, g);
                return Some(t);
            }
            _ => {
                let keep = (letters.len() / 2).max(2);
                t.truncate(letters[keep - 1] + 1);
                return Some(t);
            }
        }
    }
    None
}

fn measure(raw: &RawWord, mistake: bool, units: &[Unit], p: &Params, rng: &mut Rng) -> Word {
    let mut glyphs = Vec::with_capacity(raw.units.len());
    let mut width = 0.0;
    let heading_scale = if raw.heading { p.heading_scale } else { 1.0 };
    for &(u, script) in &raw.units {
        let unit = units.get(u as usize).copied().unwrap_or(Unit { w: [50.0, 50.0], ascii: 0 });
        let font = if p.has_font_b && rng.f() < p.font_mix { 1u8 } else { 0u8 };
        let script_scale = if script != 0 { 0.62 } else { 1.0 };
        let scale = (1.0 + p.size_variance * 0.09 * rng.soft()) * script_scale * heading_scale;
        let mut adv = unit.w[font as usize] * p.font_size / 100.0 * scale;
        adv += p.letter_spacing * script_scale + p.char_variance * p.font_size * 0.025 * rng.soft();
        let adv = adv.max(0.0);
        width += adv;
        glyphs.push(Glyph { unit: u, font, adv, scale, script });
    }
    Word { glyphs, width, mistake, heading: raw.heading, insert: None, overwrite: None }
}

fn pick_mistake_kind(mask: u32, rng: &mut Rng) -> u32 {
    let options = [(MK_CROSS_OUT, 0.6f32), (MK_CARET, 0.2), (MK_OVERWRITE, 0.2)];
    let total: f32 = options.iter().filter(|(k, _)| mask & k != 0).map(|(_, w)| w).sum();
    if total <= 0.0 {
        return MK_CROSS_OUT;
    }
    let mut roll = rng.f() * total;
    for (k, w) in options {
        if mask & k == 0 {
            continue;
        }
        if roll < w {
            return k;
        }
        roll -= w;
    }
    MK_CROSS_OUT
}

fn build_tokens(raw: Vec<RawTok>, units: &[Unit], ascii_map: &[i32; 128], p: &Params, rng: &mut Rng) -> Vec<Tok> {
    let mut out = Vec::with_capacity(raw.len() + 8);
    // Mistake decisions use their own stream so "shuffle mistakes" keeps the handwriting look.
    let mut mrng = Rng::new(p.seed.wrapping_mul(0x9E37_79B9).wrapping_add(p.mistake_seed.wrapping_mul(7919)).wrapping_add(3));
    // A minimum gap keeps corrections spread out instead of clustering.
    let min_gap = if p.mistake_rate >= 0.04 { 3 } else if p.mistake_rate >= 0.02 { 5 } else { 8 };
    let mut words_since_mistake = 99usize;
    for t in raw {
        match t {
            RawTok::Word(w) => {
                words_since_mistake += 1;
                let roll = p.mistake_rate > 0.0 && !w.heading && words_since_mistake > min_gap && mrng.f() < p.mistake_rate;
                let mut word = None;
                if roll {
                    match pick_mistake_kind(p.mistake_mask, &mut mrng) {
                        MK_CARET if is_mistake_candidate(&w, units, 4) => {
                            let letters = letter_positions(&w, units);
                            let idx = letters[1 + mrng.below(letters.len() - 2)];
                            let unit = w.units[idx].0;
                            let mut short = w.units.clone();
                            short.remove(idx);
                            let mut m = measure(&RawWord { units: short, heading: false }, false, units, p, rng);
                            let iw = units.get(unit as usize).map(|u| u.w[0]).unwrap_or(50.0) * p.font_size / 100.0 * 0.62;
                            m.insert = Some((idx, unit, iw));
                            word = Some(m);
                        }
                        MK_OVERWRITE if is_mistake_candidate(&w, units, 3) => {
                            let letters = letter_positions(&w, units);
                            let idx = letters[mrng.below(letters.len())];
                            let ch = units[w.units[idx].0 as usize].ascii;
                            let repl = neighbor_key(ch, &mut mrng);
                            let wrong = ascii_map[repl as usize];
                            if wrong >= 0 && repl != ch {
                                let mut m = measure(&w, false, units, p, rng);
                                m.overwrite = Some((idx, wrong));
                                word = Some(m);
                            }
                        }
                        MK_CROSS_OUT if is_mistake_candidate(&w, units, 3) => {
                            if let Some(typo) = make_typo(&w, units, ascii_map, &mut mrng) {
                                let tw = RawWord { units: typo, heading: false };
                                out.push(Tok::Word(measure(&tw, true, units, p, rng)));
                                out.push(Tok::Space(space_adv(p, rng, false)));
                                words_since_mistake = 0;
                            }
                        }
                        _ => {}
                    }
                    if word.is_some() {
                        words_since_mistake = 0;
                    }
                }
                out.push(Tok::Word(word.unwrap_or_else(|| measure(&w, false, units, p, rng))));
            }
            RawTok::Space(h) => out.push(Tok::Space(space_adv(p, rng, h))),
            RawTok::Newline => out.push(Tok::Newline),
            RawTok::Page => out.push(Tok::Page),
        }
    }
    out
}

fn space_adv(p: &Params, rng: &mut Rng, heading: bool) -> f32 {
    let base = p.space_w[0] * p.font_size / 100.0 * if heading { p.heading_scale } else { 1.0 };
    (base + p.word_spacing + p.char_variance * p.font_size * 0.04 * rng.soft()).max(p.font_size * 0.12)
}

struct Engine {
    p: Params,
    base: Geom,
    overrides: Vec<(usize, Geom)>,
    rng: Rng,
    out: Output,
    page: usize,
    baseline: f32,
    geom: Geom,
}

struct Line {
    words: Vec<(Word, f32)>,
    width: f32,
    avail: f32,
    indent: f32,
}

impl Engine {
    fn geom_for(&self, page: usize) -> Geom {
        self.overrides.iter().find(|(pg, _)| *pg == page).map(|(_, g)| *g).unwrap_or(self.base)
    }

    fn new_page(&mut self) {
        if self.page + 1 >= self.p.max_pages {
            return;
        }
        self.page += 1;
        self.out.pages = self.out.pages.max(self.page + 1);
        self.geom = self.geom_for(self.page);
        self.baseline = self.geom.mt;
    }

    fn ensure_room(&mut self) {
        if self.baseline > self.p.page_h - self.geom.mb + 0.5 {
            self.new_page();
        }
    }

    fn begin_line(&mut self, first_in_par: bool) -> Line {
        self.ensure_room();
        let indent = if first_in_par { self.p.indent } else { 0.0 };
        let avail = (self.p.page_w - self.geom.ml - self.geom.mr - indent).max(self.p.font_size * 2.0);
        Line { words: Vec::new(), width: 0.0, avail, indent }
    }

    fn layout(&mut self, tokens: Vec<Tok>) {
        let mut first_in_par = true;
        let mut line: Option<Line> = None;
        let mut pending_space = 0.0f32;
        for tok in tokens {
            match tok {
                Tok::Space(w) => {
                    let at_line_start = line.as_ref().map(|l| l.words.is_empty()).unwrap_or(true);
                    if !at_line_start || first_in_par {
                        pending_space += w;
                    }
                }
                Tok::Word(word) => {
                    if line.is_none() {
                        line = Some(self.begin_line(first_in_par));
                    }
                    let fits = {
                        let l = line.as_ref().unwrap();
                        l.words.is_empty() || l.width + pending_space + word.width <= l.avail
                    };
                    if !fits {
                        let l = line.take().unwrap();
                        self.place(l, false, first_in_par);
                        first_in_par = false;
                        pending_space = 0.0;
                        line = Some(self.begin_line(false));
                    }
                    let avail = line.as_ref().unwrap().avail;
                    if line.as_ref().unwrap().words.is_empty() && pending_space + word.width > avail {
                        // Break an over-long word across lines.
                        let mut chunk = Word::empty_like(&word);
                        for g in word.glyphs.iter().copied() {
                            if !chunk.glyphs.is_empty() && chunk.width + g.adv > avail {
                                let mut l = line.take().unwrap();
                                l.width = chunk.width;
                                l.words.push((std::mem::replace(&mut chunk, Word::empty_like(&word)), 0.0));
                                self.place(l, false, first_in_par);
                                first_in_par = false;
                                line = Some(self.begin_line(false));
                            }
                            chunk.width += g.adv;
                            chunk.glyphs.push(g);
                        }
                        let l = line.as_mut().unwrap();
                        l.width = chunk.width;
                        l.words.push((chunk, 0.0));
                    } else {
                        let l = line.as_mut().unwrap();
                        let space = if l.words.is_empty() && !first_in_par { 0.0 } else { pending_space };
                        l.width += space + word.width;
                        l.words.push((word, space));
                    }
                    pending_space = 0.0;
                }
                Tok::Newline => {
                    let l = match line.take() {
                        Some(l) => l,
                        None => self.begin_line(first_in_par),
                    };
                    self.place(l, true, first_in_par);
                    first_in_par = true;
                    pending_space = 0.0;
                }
                Tok::Page => {
                    if let Some(l) = line.take() {
                        self.place(l, true, first_in_par);
                    }
                    self.new_page();
                    first_in_par = true;
                    pending_space = 0.0;
                }
            }
        }
        if let Some(l) = line.take() {
            self.place(l, true, first_in_par);
        }
    }

    fn place(&mut self, line: Line, par_end: bool, first_in_par: bool) {
        let p = self.p;
        let fs = p.font_size;
        let page = self.page as f32;
        let baseline = self.baseline;
        self.baseline += self.geom.line_h;
        if line.words.is_empty() {
            return;
        }
        let rng = &mut self.rng;
        let slack = (line.avail - line.width).max(0.0);
        let mut x = self.geom.ml + if first_in_par { line.indent } else { 0.0 } + p.margin_jitter * rng.f();
        let mut gap_extra = 0.0;
        match p.align {
            1 => x += slack / 2.0,
            2 => x += slack - p.margin_jitter * 0.5,
            3 if !par_end && line.words.len() > 1 => gap_extra = slack / (line.words.len() - 1) as f32,
            _ => {}
        }
        let slope = p.line_slope * rng.soft();
        let slope_tan = slope.tan();
        let phase = rng.f() * std::f32::consts::TAU;
        let freq = std::f32::consts::TAU / (fs * rng.range(5.0, 9.0));
        let x0 = x;
        let mut heading_span: Option<(f32, f32)> = None;
        let line_is_heading = line.words.iter().all(|(w, _)| w.heading);
        for (wi, (word, space)) in line.words.into_iter().enumerate() {
            x += space + if wi > 0 { gap_extra } else { 0.0 };
            let word_rot = p.char_variance * 0.035 * rng.soft();
            let word_dy = p.char_variance * fs * 0.035 * rng.soft();
            let word_x0 = x;
            let mut caret_x: Option<f32> = None;
            for (gi, g) in word.glyphs.iter().enumerate() {
                if let Some((at, _, _)) = word.insert {
                    if at == gi {
                        caret_x = Some(x);
                    }
                }
                let dy_line = (x - x0) * slope_tan;
                let wob = p.baseline_wobble * (x * freq + phase).sin();
                let jitter = p.char_variance * fs * 0.022 * rng.soft();
                let script_dy = match g.script {
                    1 => -0.38 * fs,
                    -1 => 0.16 * fs,
                    _ => 0.0,
                };
                let y = baseline + dy_line + wob + jitter + word_dy + script_dy;
                let rot = p.tilt + slope + word_rot + p.char_variance * 0.055 * rng.soft();
                let opacity = (p.opacity * (1.0 - p.ink_variance * 0.42 * rng.f())).clamp(0.05, 1.0);
                let skew = p.char_variance * 0.07 * rng.soft();
                let mut flags = if word.mistake { FLAG_MISTAKE } else { 0.0 } + if word.heading { FLAG_HEADING } else { 0.0 };
                match word.overwrite {
                    Some((at, wrong)) if at == gi => {
                        let wrong_rot = rot + 0.05 * rng.soft();
                        self.out.glyphs.extend_from_slice(&[page, wrong as f32, x, y, wrong_rot, g.scale, g.font as f32, opacity * 0.9, skew, flags + FLAG_OVERWRITTEN]);
                        self.out.glyph_count += 1;
                        flags += FLAG_OVERWRITE;
                    }
                    _ => {}
                }
                self.out.glyphs.extend_from_slice(&[page, g.unit as f32, x, y, rot, g.scale, g.font as f32, opacity, skew, flags]);
                self.out.glyph_count += 1;
                x += g.adv;
            }
            let word_x1 = x - p.letter_spacing.max(0.0) * 0.5;
            let mid_dy = ((word_x0 + word_x1) * 0.5 - x0) * slope_tan;
            if let (Some((_, unit, iw)), Some(cx)) = (word.insert, caret_x) {
                let cx = cx - fs * 0.03;
                let by = baseline + (cx - x0) * slope_tan + word_dy;
                let lift = fs * rng.range(0.62, 0.74);
                let rot = p.tilt + slope + p.char_variance * 0.06 * rng.soft();
                let opacity = (p.opacity * (1.0 - p.ink_variance * 0.3 * rng.f())).clamp(0.05, 1.0);
                self.out.glyphs.extend_from_slice(&[page, unit as f32, cx - iw * 0.5, by - lift, rot, 0.62, 0.0, opacity, 0.0, FLAG_INSERT]);
                self.out.glyph_count += 1;
                let w = fs * rng.range(0.1, 0.14);
                let apex = (cx + fs * 0.01 * rng.soft(), by - fs * rng.range(0.2, 0.26));
                let pts = [
                    (cx - w, by + fs * 0.1),
                    (cx - w * 0.45, by - fs * 0.05),
                    apex,
                    apex,
                    (cx + w * 0.45, by - fs * 0.05),
                    (cx + w, by + fs * 0.1),
                ];
                push_stroke(&mut self.out, page, STROKE_CARET, &pts);
            }
            if word.mistake {
                let ymid = baseline + mid_dy + word_dy - fs * 0.27;
                let style = if p.cross_style == 4 {
                    match rng.below(10) {
                        0..=2 => 0,
                        3 | 4 => 1,
                        5..=7 => 2,
                        _ => 3,
                    }
                } else {
                    p.cross_style
                };
                let strokes = cross_out(style, word_x0 - fs * 0.06, word_x1 + fs * 0.04, ymid, fs, slope, rng);
                for (kind, pts) in strokes {
                    push_stroke(&mut self.out, page, kind, &pts);
                }
            }
            if word.heading && line_is_heading && p.underline_headings {
                heading_span = Some(match heading_span {
                    None => (word_x0, word_x1),
                    Some((a, _)) => (a, word_x1),
                });
            }
        }
        if let Some((a, b)) = heading_span {
            let mut pts = Vec::new();
            let n = 14;
            let y0 = baseline + fs * 0.14;
            for k in 0..=n {
                let t = k as f32 / n as f32;
                let xx = a - fs * 0.1 + (b - a + fs * 0.25) * t;
                let yy = y0 + (xx - x0) * slope_tan + fs * 0.025 * rng.soft() + t * fs * 0.04 * rng.signed();
                pts.push((xx, yy));
            }
            push_stroke(&mut self.out, page, STROKE_UNDERLINE, &pts);
        }
    }
}

fn push_stroke(out: &mut Output, page: f32, kind: f32, pts: &[(f32, f32)]) {
    out.strokes.push(page);
    out.strokes.push(kind);
    out.strokes.push(pts.len() as f32);
    for &(x, y) in pts {
        out.strokes.push(x);
        out.strokes.push(y);
    }
    out.stroke_count += 1;
}

/// Pen paths for a crossed-out word. Style: 0 single, 1 double, 2 wavy, 3 scribble.
fn cross_out(style: i32, x0: f32, x1: f32, ymid: f32, fs: f32, slope: f32, rng: &mut Rng) -> Vec<(f32, Vec<(f32, f32)>)> {
    let len = (x1 - x0).max(fs * 0.4);
    let tan = slope.tan();
    let straight = |rng: &mut Rng, dy: f32| -> Vec<(f32, f32)> {
        let n = 10;
        let tilt = rng.signed() * fs * 0.06;
        let mut pts = Vec::with_capacity(n + 1);
        for k in 0..=n {
            let t = k as f32 / n as f32;
            let x = x0 + len * t;
            let y = ymid + dy + (x - x0) * tan + tilt * (t - 0.5) + fs * 0.012 * rng.soft();
            pts.push((x, y));
        }
        pts
    };
    match style {
        1 => vec![
            (STROKE_STRIKE, straight(rng, -fs * 0.075)),
            (STROKE_STRIKE, straight(rng, fs * 0.075)),
        ],
        2 => {
            let period = fs * rng.range(0.28, 0.36);
            let amp = fs * 0.075;
            let steps = ((len / period) * 8.0).ceil().max(8.0) as usize;
            let phase = rng.f() * 6.28;
            let mut pts = Vec::with_capacity(steps + 1);
            for k in 0..=steps {
                let t = k as f32 / steps as f32;
                let x = x0 + len * t;
                let y = ymid + (x - x0) * tan + amp * ((x - x0) / period * std::f32::consts::TAU + phase).sin() + fs * 0.01 * rng.soft();
                pts.push((x, y));
            }
            vec![(STROKE_WAVY, pts)]
        }
        3 => {
            let h = fs * 0.24;
            let step = fs * rng.range(0.07, 0.1);
            let mut pts = Vec::new();
            let mut x = x0;
            let mut up = true;
            while x <= x1 + step {
                let y = ymid + (x - x0) * tan + if up { -h } else { h } * rng.range(0.7, 1.0);
                pts.push((x + rng.soft() * step * 0.3, y));
                x += step * rng.range(0.6, 1.2);
                up = !up;
            }
            let mut back = Vec::new();
            let mut x = x1;
            up = rng.f() < 0.5;
            while x >= x0 - step {
                let y = ymid + (x - x0) * tan + if up { -h } else { h } * rng.range(0.55, 0.9);
                back.push((x + rng.soft() * step * 0.3, y));
                x -= step * rng.range(0.7, 1.3);
                up = !up;
            }
            vec![(STROKE_SCRIBBLE, pts), (STROKE_SCRIBBLE, back)]
        }
        _ => {
            let mut v = vec![(STROKE_STRIKE, straight(rng, 0.0))];
            // People often go back over a single strike so the word is properly hidden.
            if rng.f() < 0.35 {
                let dy = fs * 0.035 * rng.signed();
                v.push((STROKE_STRIKE, straight(rng, dy)));
            }
            v
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(text: &str, mistake: f32) -> Vec<f32> {
        let mut p = vec![0f32; PARAM_COUNT];
        p[0] = 1000.0;
        p[1] = 400.0;
        p[2] = 50.0;
        p[3] = 50.0;
        p[4] = 60.0;
        p[5] = 40.0;
        p[6] = 50.0;
        p[7] = 40.0;
        p[13] = mistake;
        p[16] = 7.0;
        p[21] = 0.9;
        p[25] = 30.0;
        p[26] = 30.0;
        let chars: Vec<char> = ('a'..='z').collect();
        p.push(chars.len() as f32);
        for c in &chars {
            p.extend_from_slice(&[50.0, 50.0, *c as u32 as f32]);
        }
        let seq: Vec<f32> = text
            .chars()
            .map(|c| match c {
                ' ' => T_SPACE as f32,
                '\n' => T_NEWLINE as f32,
                c => (c as u32 - 'a' as u32) as f32,
            })
            .collect();
        p.push(seq.len() as f32);
        p.extend(seq);
        p.push(0.0);
        p
    }

    #[test]
    fn wraps_and_paginates() {
        let text = "hello world ".repeat(80);
        let out = run(&input(&text, 0.0));
        assert!(out.pages > 1, "expected multiple pages, got {}", out.pages);
        for g in out.glyphs.chunks(GLYPH_STRIDE) {
            assert!(g[2] >= 40.0 && g[2] <= 960.0, "glyph x out of bounds: {}", g[2]);
        }
    }

    #[test]
    fn mistakes_add_strokes() {
        let text = "assignment homework chemistry ".repeat(60);
        let out = run(&input(&text, 0.2));
        assert!(out.stroke_count > 0);
    }

    fn flags_present(out: &Output, flag: u32) -> bool {
        out.glyphs.chunks(GLYPH_STRIDE).any(|g| (g[9] as u32) & flag != 0)
    }

    #[test]
    fn caret_and_overwrite_mistakes() {
        let text = "assignment homework chemistry physics ".repeat(60);
        let mut caret = input(&text, 0.2);
        caret[30] = MK_CARET as f32;
        let out = run(&caret);
        assert!(flags_present(&out, FLAG_INSERT as u32), "expected inserted letters");
        assert!(!flags_present(&out, FLAG_MISTAKE as u32), "caret-only must not cross out");

        let mut over = input(&text, 0.2);
        over[30] = MK_OVERWRITE as f32;
        let out = run(&over);
        assert!(flags_present(&out, FLAG_OVERWRITE as u32));
        assert!(flags_present(&out, FLAG_OVERWRITTEN as u32));
        assert_eq!(out.stroke_count, 0);
    }

    #[test]
    fn mistake_seed_changes_only_mistakes() {
        let text = "assignment homework chemistry physics ".repeat(40);
        let a = run(&input(&text, 0.0));
        let mut b_in = input(&text, 0.0);
        b_in[31] = 5.0;
        let b = run(&b_in);
        assert_eq!(a.glyphs, b.glyphs, "mistake seed must not affect clean text");
    }
}
