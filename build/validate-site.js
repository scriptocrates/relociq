// SITE INTEGRITY VALIDATOR — run before every deploy.
// Guards against the class of bug where the selector offers a country with no pathway data,
// or a pathway exists with no guide. Fails loudly (non-zero exit) so a broken build can't ship.
const fs = require('fs');
const vm = require('vm');
const path = process.argv[2] || 'index.html';
const html = fs.readFileSync(path,'utf8');

let errors = [];
let warnings = [];

// origins/dests/pathwayData use JS object literal syntax (single-quoted keys) so they can't
// be parsed with JSON.parse(). vm.runInNewContext() sandboxes the expression — no access to
// require, process, fs, or any other Node global.
function grabJs(re, label){ const m=html.match(re); if(!m){errors.push('Could not find '+label);return null;} try{const s={};vm.runInNewContext('__r='+m[1],s,{timeout:2000});return s.__r;}catch(e){errors.push(label+' failed to parse: '+e.message);return null;} }

const origins = grabJs(/var origins\s*=\s*(\[[\s\S]*?\]);/, 'origins selector');
const dests   = grabJs(/var dests\s*=\s*(\[[\s\S]*?\]);/, 'dests selector');
const pathways= grabJs(/var pathwayData=(\[[\s\S]*?\]);/, 'pathwayData');
// stepsData is written by build-site.js via JSON.stringify() so strict JSON.parse() is safe.
// Regex terminates at "};\n" — semicolons never appear in JSON syntax so this is unambiguous
// regardless of whether the value is compact (one line) or pretty-printed (indented).
const stepsM  = html.match(/var stepsData = (\{[\s\S]*?\});\n/);
let stepsData=null; try{ stepsData=JSON.parse(stepsM[1]); }catch(e){ errors.push('stepsData failed to parse'); }

if(origins && pathways){
  // Every selectable origin must appear in at least one pathway
  const pathOrigins = new Set(pathways.map(p=>p.from));
  origins.forEach(o=>{ if(!pathOrigins.has(o.code)) errors.push('Selector offers origin '+o.code+' ('+o.name+') but NO pathway uses it — dead end for users.'); });
}
if(dests && pathways){
  const pathDests = new Set(pathways.map(p=>p.to));
  dests.forEach(d=>{ if(!pathDests.has(d.code)) errors.push('Selector offers destination '+d.code+' ('+d.name+') but NO pathway uses it — dead end.'); });
}
if(pathways && stepsData){
  // Every pathway should have a guide; warn (not error) if missing so we know coverage
  pathways.forEach(p=>{ const k=p.from+'-'+p.to; if(!stepsData[k]) warnings.push('Pathway '+k+' has no step-by-step guide (will show fallback).'); });
  // Every guide should correspond to a real pathway
  const pathKeys=new Set(pathways.map(p=>p.from+'-'+p.to));
  Object.keys(stepsData).forEach(k=>{ if(!pathKeys.has(k)) warnings.push('Guide '+k+' exists but no matching pathway in selector.'); });
  // Every step must have all 6 enriched fields
  Object.keys(stepsData).forEach(k=>{ stepsData[k].forEach(s=>{ if(!s.why||!s.need||!s.action||!s.risks||!s.doneWhen||!s.name) errors.push('Guide '+k+' step '+s.num+' is missing required fields.'); }); });
}

// JS validity of all inline scripts
const scripts=html.match(/<script>([\s\S]*?)<\/script>/g)||[];
scripts.forEach((s,i)=>{const code=s.replace(/<\/?script>/g,'');if(code.includes('clerk.browser.js'))return;try{new Function(code);}catch(e){errors.push('Inline script '+i+' has a JS syntax error: '+e.message);}});

// Security: no backend identifiers / secret keys in the shipped file
['appM0O6xRifFXtMa6','tblIQsKbzGPBH59dT','xano.io','sk_test','sk_live'].forEach(bad=>{ if(html.includes(bad)) errors.push('SECURITY: shipped file contains "'+bad+'" — must not be public.'); });

console.log('=== SITE INTEGRITY REPORT ===');
console.log('Origins: '+(origins?origins.length:'?')+' | Dests: '+(dests?dests.length:'?')+' | Pathways: '+(pathways?pathways.length:'?')+' | Guides: '+(stepsData?Object.keys(stepsData).length:'?'));
console.log('');
if(warnings.length){ console.log('WARNINGS ('+warnings.length+'):'); warnings.forEach(w=>console.log('  ⚠ '+w)); console.log(''); }
if(errors.length){ console.log('ERRORS ('+errors.length+') — DO NOT DEPLOY:'); errors.forEach(e=>console.log('  ✗ '+e)); process.exit(1); }
else { console.log('✓ ALL INTEGRITY CHECKS PASS — safe to deploy'); }
