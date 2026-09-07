const fs=require('fs');
const { JSDOM } = require('jsdom');
const html = fs.readFileSync('/tmp/repair/work.html','utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');
const dom = new JSDOM('<!DOCTYPE html><body></body>',{runScripts:'outside-only'});
const w=dom.window;
try{ w.eval(script); }catch(e){}

let pass=0,fail=0;
function ok(n,c,d){ if(c){pass++;console.log('  ✓ '+n);} else {fail++;console.log('  ✗ '+n+(d?' — '+d:''));} }

const pd = w.pathwayData;
console.log('═══ P0-2: no-visa routes must not display a visa fee ═══');

// The three routes named in the brief
[['IN','DE'],['SK','DE'],['SK','CZ']].forEach(([f,t])=>{
  const p = pd.find(x=>x.from===f&&x.to===t);
  const c = w.costPresentation(p);
  const noVisa = w.routeRequiresNoVisa(p);
  const block = w.costBlockHTML(p);
  console.log('  '+f+'→'+t+' ['+p.visa+']');
  console.log('     label="'+c.label+'"  value='+(c.amount===null?'—':'EUR '+c.amount));
  console.log('     qualifier="'+c.qualifier+'"');
  ok('   '+f+'→'+t+': never says "visa fees only"', !/visa fees only/i.test(block));
  if(noVisa) ok('   '+f+'→'+t+': no-visa route states no visa fee', /No visa fee/i.test(c.qualifier));
});

console.log('\n═══ P0-2: systemic sweep across all 322 routes ═══');
let contradictions=0, unlabelled=0;
pd.forEach(p=>{
  const block = w.costBlockHTML(p);
  const c = w.costPresentation(p);
  if(w.routeRequiresNoVisa(p) && /visa fee[s]? only/i.test(block)) contradictions++;
  if(w.routeRequiresNoVisa(p) && !/No visa fee/i.test(c.qualifier)) unlabelled++;
});
ok('0 routes claim a visa fee where no visa is required', contradictions===0, contradictions+' remain');
ok('all no-visa routes explicitly state "No visa fee"', unlabelled===0, unlabelled+' missing');

console.log('\n═══ P0-2: unknown / zero amounts ═══');
const uaPT = pd.find(x=>x.from==='UA'&&x.to==='PT'); // cost === 0
const cu = w.costPresentation(uaPT);
ok('zero cost renders as "—" not "EUR 0"', cu.amount===null && !/EUR 0/.test(w.costBlockHTML(uaPT)));
ok('zero cost is qualified, not silently presented as free', cu.qualifier.length>10);
// synthetic edge cases
[['missing cost',{visa:'Work Permit Visa'}],
 ['null cost',{visa:'Work Permit Visa',cost:null}],
 ['string cost',{visa:'Work Permit Visa',cost:'lots'}],
 ['negative cost',{visa:'Work Permit Visa',cost:-5}],
 ['no visa field',{cost:100}]].forEach(([label,p])=>{
  let t=null,out=null;
  try{ out=w.costBlockHTML(p); }catch(e){ t=e; }
  ok('survives '+label, t===null && out!==null, t&&t.message);
});

console.log('\n═══ P0-2: currency safety ═══');
ok('no cross-currency summing in cost path', !/cost\s*\+\s*\w+cost/i.test(script));
ok('estimates explicitly not presented as official fee schedules', /Not an official fee schedule/.test(script));

console.log('\n═══ P2: stale-result invalidation ═══');
ok('markResultStale defined', typeof w.markResultStale==='function');
ok('clearResultStale defined', typeof w.clearResultStale==='function');
ok('select() triggers invalidation', /closeAll\(\);\s*markResultStale\(\);/.test(script));
ok('stale guide is removed, not left visible', /markResultStale[\s\S]{0,600}fullGuide[\s\S]{0,60}remove\(\)/.test(script));

console.log('\n═══ P1: claims vs implementation ═══');
ok('no "Real-time updates" claim', !/Real-time updates/.test(html));
ok('no "No lawyer needed" claim', !/No lawyer needed/.test(html));
ok('no automatic-monitoring claim', !/monitors official sources and updates your pathway automatically/.test(html));
ok('no unbacked "Verified lawyer referrals"', !/Verified lawyer referrals/.test(html));
ok('coverage stated precisely from data', /18 origins · 18 destinations/.test(html));
const origins=[...new Set(pd.map(p=>p.from))], dests=[...new Set(pd.map(p=>p.to))];
ok('stated coverage matches data', origins.length===18 && dests.length===18, origins.length+'/'+dests.length);

console.log('\n'+'═'.repeat(46));
console.log('PASS '+pass+'  FAIL '+fail);
process.exit(fail?1:0);
