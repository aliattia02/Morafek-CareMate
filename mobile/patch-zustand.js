/**
 * patch-zustand.js
 * Place this in: mobile/patch-zustand.js
 * Run from:      mobile/ folder  →  node patch-zustand.js
 */

const fs   = require('fs');
const path = require('path');

// Always resolve relative to the folder you run the script FROM (mobile/)
const zustandDir = path.join(process.cwd(), 'node_modules', 'zustand');

let patchedCount = 0;

function replaceInFile(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    if (!content.includes('import.meta')) return;

    const patched = content.replace(
      /import\.meta\.env/g,
      '(typeof process !== "undefined" ? process.env : {})'
    );

    if (patched !== content) {
      fs.writeFileSync(filePath, patched, 'utf8');
      console.log('  patched:', path.relative(process.cwd(), filePath));
      patchedCount++;
    }
  } catch {
    // skip unreadable files
  }
}

function walkDir(dir) {
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return; }

  for (const entry of entries) {
    const full = path.join(dir, entry);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }

    if (stat.isDirectory()) {
      walkDir(full);
    } else if (/\.(js|mjs|cjs)$/.test(entry)) {
      replaceInFile(full);
    }
  }
}

console.log('\nPatching zustand for Metro/Hermes web compatibility...');
console.log('Looking in:', zustandDir);

if (fs.existsSync(zustandDir)) {
  walkDir(zustandDir);
  console.log(`Done. ${patchedCount} file(s) patched.\n`);
} else {
  console.error('ERROR: zustand not found at:', zustandDir);
  console.error('Make sure you run this from the mobile/ folder.\n');
  process.exit(1);
}