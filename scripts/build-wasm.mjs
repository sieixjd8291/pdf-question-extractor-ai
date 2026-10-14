// Compiles rust/handwriting-engine to WebAssembly and copies the module into
// src/lib/handwriting. The compiled .wasm is committed, so app builds (and
// Vercel deploys) never need a Rust toolchain — rerun this after Rust edits.
// Requires: rustup target add wasm32-unknown-unknown
import { execFileSync } from 'node:child_process';
import { copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const crate = path.resolve('rust/handwriting-engine');
const env = { ...process.env, PATH: `${path.join(homedir(), '.cargo/bin')}:${process.env.PATH}` };
execFileSync('cargo', ['test', '--release', '--quiet'], { cwd: crate, stdio: 'inherit', env });
execFileSync('cargo', ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: crate, stdio: 'inherit', env });
const from = path.join(crate, 'target/wasm32-unknown-unknown/release/handwriting_engine.wasm');
const to = path.resolve('src/lib/handwriting/handwriting_engine.wasm');
copyFileSync(from, to);
console.log(`wasm: ${(statSync(to).size / 1024).toFixed(1)} KB -> ${path.relative(process.cwd(), to)}`);
