//! Text preparation: converts pasted assignment text (LaTeX math, ChatGPT
//! style markdown) into plain text plus inline control markers that the
//! layout engine understands:
//!   U+0001 superscript start, U+0002 subscript start, U+0003 script end,
//!   U+0004 heading line, U+000C page break.

pub const SUP: char = '\u{1}';
pub const SUB: char = '\u{2}';
pub const END: char = '\u{3}';
pub const HEADING: char = '\u{4}';
pub const PAGE_BREAK: char = '\u{c}';

pub fn prepare(input: &str, latex: bool, markdown: bool) -> String {
    let mut out = String::with_capacity(input.len() + 16);
    let mut in_math = false;
    for (li, raw) in input.split('\n').enumerate() {
        if li > 0 {
            out.push('\n');
        }
        let mut line = raw.trim_end_matches('\r').replace('\t', "    ");
        if markdown {
            line = clean_markdown_line(&line);
        }
        if latex {
            line = convert_latex(&line, &mut in_math);
        }
        out.push_str(&line);
    }
    out
}

fn clean_markdown_line(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed == "---" || trimmed == "***" || trimmed == "___" {
        return String::new();
    }
    let mut heading = false;
    let mut body = line.to_string();
    if trimmed.starts_with('#') {
        heading = true;
        body = trimmed.trim_start_matches('#').trim_start().to_string();
    } else if trimmed.len() > 4 && trimmed.starts_with("**") && trimmed.ends_with("**") && !trimmed[2..trimmed.len() - 2].contains("**") {
        heading = true;
        body = trimmed.to_string();
    }
    let lead_ws: usize = body.len() - body.trim_start().len();
    let rest = &body[lead_ws..];
    let rest = if let Some(r) = rest.strip_prefix("* ") {
        format!("- {r}")
    } else if let Some(r) = rest.strip_prefix("• ") {
        format!("- {r}")
    } else {
        rest.to_string()
    };
    let mut cleaned = format!("{}{}", &body[..lead_ws], rest);
    cleaned = cleaned.replace("**", "").replace("__", "").replace('`', "");
    if heading {
        format!("{HEADING}{}", cleaned.trim())
    } else {
        cleaned
    }
}

pub fn convert_latex(line: &str, in_math: &mut bool) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    let mut out = String::with_capacity(line.len());
    parse_seq(&chars, &mut i, None, &mut out, in_math);
    out
}

fn parse_seq(c: &[char], i: &mut usize, stop: Option<char>, out: &mut String, in_math: &mut bool) {
    while *i < c.len() {
        let ch = c[*i];
        if Some(ch) == stop {
            *i += 1;
            return;
        }
        match ch {
            '\\' => parse_command(c, i, out, in_math),
            '$' if !*in_math && !c[*i + 1..].contains(&'$') => {
                out.push('$');
                *i += 1;
            }
            '$' => {
                *i += 1;
                if *i < c.len() && c[*i] == '$' {
                    *i += 1;
                }
                *in_math = !*in_math;
            }
            '^' if *i + 1 < c.len() && !c[*i + 1].is_whitespace() => {
                *i += 1;
                let g = read_group(c, i, in_math);
                push_script(out, SUP, &g);
            }
            '_' if *i + 1 < c.len() && is_subscript_context(c, *i, *in_math) => {
                *i += 1;
                let g = read_group(c, i, in_math);
                push_script(out, SUB, &g);
            }
            '{' | '}' if *in_math => {
                *i += 1;
            }
            _ => {
                out.push(ch);
                *i += 1;
            }
        }
    }
}

fn is_subscript_context(c: &[char], i: usize, in_math: bool) -> bool {
    if in_math {
        return true;
    }
    let next = c[i + 1];
    let prev = if i > 0 { c[i - 1] } else { ' ' };
    next == '{' || (prev.is_alphanumeric() && next.is_ascii_digit() && (i + 2 >= c.len() || !c[i + 2].is_lowercase()))
}

fn read_group(c: &[char], i: &mut usize, in_math: &mut bool) -> String {
    while *i < c.len() && c[*i] == ' ' {
        *i += 1;
    }
    let mut sub = String::new();
    if *i >= c.len() {
        return sub;
    }
    match c[*i] {
        '{' => {
            *i += 1;
            let was = *in_math;
            *in_math = true;
            parse_seq(c, i, Some('}'), &mut sub, in_math);
            *in_math = was;
        }
        '\\' => {
            let was = *in_math;
            *in_math = true;
            parse_command(c, i, &mut sub, in_math);
            *in_math = was;
        }
        ch => {
            sub.push(ch);
            *i += 1;
        }
    }
    sub
}

fn strip_markers(s: &str) -> String {
    s.chars().filter(|ch| !matches!(*ch, SUP | SUB | END)).collect()
}

fn push_script(out: &mut String, kind: char, g: &str) {
    let g = strip_markers(g);
    if g.is_empty() {
        return;
    }
    if kind == SUP && (g == "°" || g == "∘") {
        out.push('°');
        return;
    }
    out.push(kind);
    out.push_str(&g);
    out.push(END);
}

fn wrap(s: &str) -> String {
    let plain = strip_markers(s);
    if plain.chars().count() <= 1 || plain.chars().all(|ch| ch.is_alphanumeric() || ch == '.') {
        s.to_string()
    } else {
        format!("({s})")
    }
}

fn combining(s: &str, mark: char) -> String {
    let mut o = String::new();
    for ch in s.chars() {
        o.push(ch);
        if ch.is_alphanumeric() {
            o.push(mark);
        }
    }
    o
}

fn parse_command(c: &[char], i: &mut usize, out: &mut String, in_math: &mut bool) {
    *i += 1; // backslash
    if *i >= c.len() {
        out.push('\\');
        return;
    }
    let first = c[*i];
    if !first.is_ascii_alphabetic() {
        *i += 1;
        match first {
            '\\' => out.push('\n'),
            ',' | ';' | ':' | ' ' => out.push(' '),
            '!' => {}
            '(' | '[' => *in_math = true,
            ')' | ']' => *in_math = false,
            '{' | '}' | '%' | '$' | '&' | '_' | '#' => out.push(first),
            '|' => out.push('‖'),
            other => out.push(other),
        }
        return;
    }
    let start = *i;
    while *i < c.len() && c[*i].is_ascii_alphabetic() {
        *i += 1;
    }
    let name: String = c[start..*i].iter().collect();
    match name.as_str() {
        "frac" | "dfrac" | "tfrac" | "cfrac" => {
            let a = read_group(c, i, in_math);
            let b = read_group(c, i, in_math);
            out.push_str(&wrap(&a));
            out.push('/');
            out.push_str(&wrap(&b));
        }
        "sqrt" => {
            let mut index = String::new();
            if *i < c.len() && c[*i] == '[' {
                *i += 1;
                while *i < c.len() && c[*i] != ']' {
                    index.push(c[*i]);
                    *i += 1;
                }
                *i += 1;
            }
            let g = read_group(c, i, in_math);
            if !index.is_empty() {
                push_script(out, SUP, &index);
            }
            out.push('√');
            out.push_str(&wrap(&g));
        }
        "text" | "textrm" | "mathrm" | "mathbf" | "textbf" | "textit" | "mathit" | "emph" | "mathsf"
        | "mathcal" | "mathbb" | "operatorname" | "boldsymbol" | "mbox" | "underline" => {
            let g = read_group(c, i, in_math);
            out.push_str(&g);
        }
        "overline" | "bar" => out.push_str(&combining(&read_group(c, i, in_math), '\u{0304}')),
        "vec" => out.push_str(&combining(&read_group(c, i, in_math), '\u{20D7}')),
        "hat" | "widehat" => out.push_str(&combining(&read_group(c, i, in_math), '\u{0302}')),
        "dot" => out.push_str(&combining(&read_group(c, i, in_math), '\u{0307}')),
        "ddot" => out.push_str(&combining(&read_group(c, i, in_math), '\u{0308}')),
        "tilde" | "widetilde" => out.push_str(&combining(&read_group(c, i, in_math), '\u{0303}')),
        "begin" | "end" => {
            let _ = read_group(c, i, in_math);
        }
        "left" | "right" | "bigl" | "bigr" | "Bigl" | "Bigr" | "big" | "Big" | "bigg" | "Bigg" => {
            if *i < c.len() && c[*i] == '.' {
                *i += 1;
            }
        }
        "displaystyle" | "textstyle" | "limits" | "nolimits" | "noindent" | "centering" => {}
        "quad" => out.push_str("  "),
        "qquad" => out.push_str("    "),
        "newpage" | "pagebreak" | "clearpage" => out.push(PAGE_BREAK),
        "newline" | "linebreak" => out.push('\n'),
        "sin" | "cos" | "tan" | "sec" | "csc" | "cot" | "log" | "ln" | "exp" | "lim" | "max" | "min"
        | "arcsin" | "arccos" | "arctan" | "sinh" | "cosh" | "tanh" | "det" | "gcd" | "deg" | "mod"
        | "sup" | "inf" | "arg" | "dim" | "ker" => out.push_str(&name),
        other => match symbol(other) {
            Some(s) => out.push_str(s),
            None => out.push_str(other),
        },
    }
}

fn symbol(name: &str) -> Option<&'static str> {
    Some(match name {
        "alpha" => "α", "beta" => "β", "gamma" => "γ", "delta" => "δ", "epsilon" => "ε",
        "varepsilon" => "ε", "zeta" => "ζ", "eta" => "η", "theta" => "θ", "vartheta" => "ϑ",
        "iota" => "ι", "kappa" => "κ", "lambda" => "λ", "mu" => "μ", "nu" => "ν", "xi" => "ξ",
        "pi" => "π", "varpi" => "ϖ", "rho" => "ρ", "sigma" => "σ", "varsigma" => "ς", "tau" => "τ",
        "upsilon" => "υ", "phi" => "φ", "varphi" => "φ", "chi" => "χ", "psi" => "ψ", "omega" => "ω",
        "Gamma" => "Γ", "Delta" => "Δ", "Theta" => "Θ", "Lambda" => "Λ", "Xi" => "Ξ", "Pi" => "Π",
        "Sigma" => "Σ", "Upsilon" => "Υ", "Phi" => "Φ", "Psi" => "Ψ", "Omega" => "Ω",
        "times" => "×", "div" => "÷", "pm" => "±", "mp" => "∓", "cdot" => "·", "ast" => "*",
        "leq" | "le" => "≤", "geq" | "ge" => "≥", "neq" | "ne" => "≠", "approx" => "≈",
        "equiv" => "≡", "sim" => "∼", "simeq" => "≃", "cong" => "≅", "propto" => "∝",
        "infty" => "∞", "sum" => "Σ", "prod" => "Π", "int" => "∫", "iint" => "∬", "oint" => "∮",
        "partial" => "∂", "nabla" => "∇", "to" | "rightarrow" => "→", "leftarrow" | "gets" => "←",
        "Rightarrow" | "implies" => "⇒", "Leftarrow" => "⇐", "Leftrightarrow" | "iff" => "⇔",
        "leftrightarrow" => "↔", "uparrow" => "↑", "downarrow" => "↓", "mapsto" => "↦",
        "in" => "∈", "notin" => "∉", "ni" => "∋", "subset" => "⊂", "subseteq" => "⊆",
        "supset" => "⊃", "supseteq" => "⊇", "cup" => "∪", "cap" => "∩", "setminus" => "∖",
        "forall" => "∀", "exists" => "∃", "emptyset" | "varnothing" => "∅", "neg" | "lnot" => "¬",
        "land" | "wedge" => "∧", "lor" | "vee" => "∨", "angle" => "∠", "degree" => "°", "circ" => "∘",
        "perp" => "⊥", "parallel" => "∥", "therefore" => "∴", "because" => "∵",
        "ldots" | "dots" | "cdots" => "...", "vdots" => "⋮", "prime" => "′", "hbar" => "ħ",
        "ell" => "ℓ", "Re" => "ℜ", "Im" => "ℑ", "aleph" => "ℵ", "triangle" => "△", "square" => "□",
        "star" => "⋆", "bullet" => "•", "langle" => "⟨", "rangle" => "⟩", "lfloor" => "⌊",
        "rfloor" => "⌋", "lceil" => "⌈", "rceil" => "⌉", "mid" => "|", "vert" => "|",
        "percent" => "%", "dagger" => "†", "oplus" => "⊕", "otimes" => "⊗", "ll" => "≪", "gg" => "≫",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_common_math() {
        let mut m = false;
        assert_eq!(convert_latex(r"\frac{1}{2}", &mut m), "1/2");
        assert_eq!(convert_latex(r"\sqrt{x+1}", &mut m), "√(x+1)");
        assert_eq!(convert_latex("x^2", &mut m), format!("x{SUP}2{END}"));
        assert_eq!(convert_latex(r"90^\circ", &mut m), "90°");
        assert_eq!(convert_latex(r"a \times b", &mut m), "a × b");
        assert_eq!(convert_latex("file_name", &mut m), "file_name");
        assert_eq!(convert_latex("H_2O", &mut m), format!("H{SUB}2{END}O"));
    }

    #[test]
    fn cleans_markdown() {
        let out = prepare("## Intro\n**bold** text\n* item", false, true);
        assert_eq!(out, format!("{HEADING}Intro\nbold text\n- item"));
    }
}
