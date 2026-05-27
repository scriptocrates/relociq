// RELOCIQ SITE BUILD
// Regenerates the stepsData in index.html from the content layer:
//   - frameworks/*.json  + deltas/*.json   -> merged corridor guides
//   - standalone/*.json                    -> used verbatim
//   - any corridor NOT yet migrated to content/ falls back to the existing
//     stepsData already in the HTML (so partial migration never drops a corridor).
//
// This is the script a future Paperclip build-agent runs. For now, Claude runs it
// via the connector and hands the result off for git commit.
const fs = require('fs');
const path = require('path');
const { mergeFrameworkDelta } = require('./merge-engine.js');

const CONTENT = path.join(__dirname, '..', 'content');
const HTML = process.argv[2];
if (!HTML) { console.error('Usage: node build-site.js <path-to-index.html>'); process.exit(1); }

// 1. Load frameworks
const frameworks = {};
fs.readdirSync(path.join(CONTENT,'frameworks')).filter(f=>f.endsWith('.json')).forEach(f=>{
  const fw = JSON.parse(fs.readFileSync(path.join(CONTENT,'frameworks',f),'utf8'));
  frameworks[fw.framework_key] = fw;
});

// 2. Build guides from deltas
const built = {};
fs.readdirSync(path.join(CONTENT,'deltas')).filter(f=>f.endsWith('.json')).forEach(f=>{
  const d = JSON.parse(fs.readFileSync(path.join(CONTENT,'deltas',f),'utf8'));
  const fw = frameworks[d.framework_key];
  if (!fw) throw new Error('Delta '+d.delta_key+' references unknown framework '+d.framework_key);
  built[d.corridor] = mergeFrameworkDelta(fw, d);
});

// 3. Standalones (verbatim) — override anything above
fs.readdirSync(path.join(CONTENT,'standalone')).filter(f=>f.endsWith('.json')).forEach(f=>{
  const s = JSON.parse(fs.readFileSync(path.join(CONTENT,'standalone',f),'utf8'));
  built[s.corridor] = s.steps.map((st,i)=>({num:i+1,name:st.name,days:st.days,critical:st.critical,why:st.why,need:st.need,action:st.action,risks:st.risks,doneWhen:st.doneWhen}));
});

// 4. Load existing stepsData from HTML as the fallback base (so un-migrated corridors persist)
let html = fs.readFileSync(HTML,'utf8');
const m = html.match(/var stepsData = (\{[\s\S]*?\n\});/);
if(!m) throw new Error('stepsData not found in HTML');
const existing = JSON.parse(m[1]);

// 5. Merge: content-built corridors override existing; rest persist unchanged
const final = Object.assign({}, existing, built);

// 6. Serialize and write back
const block = '// ── GUIDE CONTENT — GENERATED. DO NOT EDIT BY HAND. ──\n'
  + '// Source: content/ layer (frameworks + deltas + standalone), regenerated via build-site.js\n'
  + 'var stepsData = ' + JSON.stringify(final, null, 2) + ';';
html = html.replace(/(?:\/\/ ──[^\n]*\n)*var stepsData = \{[\s\S]*?\n\};/, block);
fs.writeFileSync(HTML, html);

console.log('BUILD COMPLETE');
console.log('  From content layer:', Object.keys(built).length, 'corridors');
console.log('  Total corridors in site:', Object.keys(final).length);
console.log('  Content-built:', Object.keys(built).sort().join(', '));
