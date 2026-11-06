// Gera os áudios do app com Google Cloud Text-to-Speech (Chirp 3 HD).
// Uso: node tools/gerar-audios.mjs [--force] [--voice Leda] [--project anthor-automation-sandbox]
// Lê o index.html, junta todas as falas (palavras, figurinhas e frases dos say()),
// grava audio/<lang>_<slug>.mp3 e audio/manifest.json. Arquivos existentes são mantidos (use --force para regravar).
import fs from 'node:fs';
import path from 'node:path';
import {execSync} from 'node:child_process';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const FORCE = process.argv.includes('--force');
const VOICE = arg('--voice', 'Leda');
const PROJECT = arg('--project', 'anthor-automation-sandbox');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const outDir = path.join(root, 'audio');
fs.mkdirSync(outDir, {recursive: true});

const slug = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const clips = new Map(); // name -> {lang, text}
const add = (lang, text) => { text = text.trim(); if (text) clips.set(`${lang}_${slug(text)}`, {lang, text}); };
const strs = s => [...s.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1]);

// palavras e figurinhas
for (const m of html.matchAll(/\{en:'([^']+)'/g)) add('en', m[1]);
const stickers = html.match(/const STICKERS = \[([\s\S]*?)\];/)[1];
for (const m of stickers.matchAll(/\['[^']*','([^']+)'/g)) add('en', m[1]);
// frases: ['pt','...'], ['pt', rand([...])], ['pt', cond ? '...' : '...'], ['pt', cond ? rand([...]) : rand([...])]
for (const m of html.matchAll(/\['(pt|en)',\s*([^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*)\]/g)) {
  const [, lang, rest] = m;
  if (/^\s*(w|o|s)(\.en|\[1\])/.test(rest)) continue; // palavra dinâmica, já coberta
  for (const s of strs(rest)) add(lang, s);
}

const token = execSync('gcloud auth application-default print-access-token', {encoding: 'utf8'}).trim();
const VOICES = {en: {languageCode: 'en-US', name: `en-US-Chirp3-HD-${VOICE}`}, pt: {languageCode: 'pt-BR', name: `pt-BR-Chirp3-HD-${VOICE}`}};
const isWord = (lang, text) => lang === 'en' && !/[!.?,]/.test(text);

async function synth(lang, text) {
  // palavras isoladas saem um pouco mais devagar e com ponto final, para soar completas
  const input = isWord(lang, text) ? text.charAt(0).toUpperCase() + text.slice(1) + '.' : text;
  const body = {input: {text: input}, voice: VOICES[lang], audioConfig: {audioEncoding: 'MP3', speakingRate: isWord(lang, text) ? 0.85 : 0.95}};
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize', {
      method: 'POST',
      headers: {'Authorization': `Bearer ${token}`, 'x-goog-user-project': PROJECT, 'Content-Type': 'application/json'},
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (r.ok) return Buffer.from(j.audioContent, 'base64');
    if (r.status === 400 && body.audioConfig.speakingRate !== undefined) { delete body.audioConfig.speakingRate; continue; }
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000)); continue; }
    throw new Error(`${r.status} ${j.error?.message}`);
  }
  throw new Error('falhou depois de 3 tentativas');
}

let made = 0, kept = 0, chars = 0;
const list = [...clips.entries()];
const queue = list.slice();
await Promise.all([1, 2, 3, 4].map(async () => {
  while (queue.length) {
    const [name, {lang, text}] = queue.shift();
    const file = path.join(outDir, name + '.mp3');
    if (!FORCE && fs.existsSync(file)) { kept++; continue; }
    fs.writeFileSync(file, await synth(lang, text));
    made++; chars += text.length;
  }
}));
// remove áudios que não são mais usados
for (const f of fs.readdirSync(outDir)) if (f.endsWith('.mp3') && !clips.has(f.slice(0, -4))) fs.unlinkSync(path.join(outDir, f));
fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify({voice: VOICE, clips: list.map(([n]) => n).sort()}, null, 1));
console.log(`voz ${VOICE}: ${list.length} falas, ${made} geradas (${chars} caracteres), ${kept} mantidas`);
