const fs=require('fs');
const { JSDOM } = require('jsdom');
const html=fs.readFileSync('/tmp/repair/work3.html','utf8');
const script=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]).join('\n');

// Rebuild the real modal DOM from the deployed markup
const modal = html.match(/<div class="auth-overlay" id="recOverlay"[\s\S]*?<!-- NAV -->/);
const dom=new JSDOM(`<!DOCTYPE html><body>
<div class="hero">
 <div class="sel-wrap"><div id="fromBtn"></div><div id="fromDD"></div><div id="fromList"></div><span id="fromFlag"></span><span id="fromVal"></span></div>
 <div class="sel-wrap"><div id="toBtn"></div><div id="toDD"></div><div id="toList"></div><span id="toFlag"></span><span id="toVal"></span></div>
</div>
<div id="navSignin"></div><div id="navSignup"></div><div id="navUser"></div><div id="navEmail"></div>
<div id="authOverlay"></div><div id="authSignup"></div><div id="authSignin"></div><div id="authVerify"></div>
<div id="infoOverlay"></div><div id="infoTitle"></div><div id="infoBody"></div>
<div id="conciergePanel"></div><div id="conciergeMessages"></div><div id="conciergeSuggestions"></div>
<div id="conciergeInput"></div><div id="conciergeSendBtn"></div><div id="conciergeTitle"></div>
${modal?modal[0].replace('<!-- NAV -->',''):''}</body>`,{runScripts:'outside-only', url:'https://relociq.app/'});
const w=dom.window;
w.Element.prototype.scrollIntoView=function(){};
let evalErr=null;
try{ w.eval(script); }catch(e){ evalErr=e; }
if(evalErr) console.log('  [harness] init stopped at: '+evalErr.message);
console.log('  [harness] RECOMMENDER_ENDPOINT: '+(w.RECOMMENDER_ENDPOINT||'UNDEFINED'));

let p=0,f=0; const ok=(n,c,d)=>{c?(p++,console.log('  ✓ '+n)):(f++,console.log('  ✗ '+n+(d?' — '+d:'')))};

function fillForm(){
  w.document.getElementById('recNationality').innerHTML='<option value="IN">India</option>';
  w.document.getElementById('recNationality').value='IN';
  w.document.getElementById('recRole').value='Software engineer';
  w.document.getElementById('recSalary').value='40000';
  w.document.getElementById('recLanguages').value='English';
  w.document.getElementById('recPartner').value='false';
  w.document.getElementById('recChildren').value='0';
  w.document.getElementById('recNotes').value='';
}
const shown = ()=> w.document.getElementById('recResultsList').textContent;
const cards = ()=> w.document.querySelectorAll('#recResultsList > div').length;

(async()=>{
console.log('═══ A. Model returns ISO codes (schema-compliant) ═══');
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'CZ',country_name:'Czech Republic',match_score:0.82,rationale:'r1',key_advantages:['a','b'],considerations:['c'],visa_route:'Employee Card',monthly_cost_estimate_eur:1500},
 {rank:2,country:'PL',country_name:'Poland',match_score:0.78,rationale:'r2',key_advantages:['a','b'],considerations:['c'],visa_route:'Type A',monthly_cost_estimate_eur:1400},
 {rank:3,country:'DE',country_name:'Germany',match_score:0.61,rationale:'r3',key_advantages:['a'],considerations:['c'],visa_route:'Work Permit',monthly_cost_estimate_eur:2200}]})});
fillForm();
await w.submitRecommender();
await new Promise(r=>setTimeout(r,50));
ok('renders 3 cards', cards()===3, cards()+' cards');
ok('results panel visible', w.document.getElementById('recResultsStep').style.display==='');
ok('loading hidden', w.document.getElementById('recLoadingStep').style.display==='none');

console.log('\n═══ B. Model returns FULL COUNTRY NAMES instead of codes ═══');
console.log('    (schema says two-letter code, but models drift)');
w.document.getElementById('recResultsList').textContent='';
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'Czech Republic',country_name:'Czech Republic',match_score:0.82,rationale:'r1',key_advantages:['a','b'],considerations:['c'],visa_route:'Employee Card',monthly_cost_estimate_eur:1500},
 {rank:2,country:'Poland',country_name:'Poland',match_score:0.78,rationale:'r2',key_advantages:['a'],considerations:['c'],visa_route:'Type A',monthly_cost_estimate_eur:1400}]})});
fillForm();
await w.submitRecommender();
await new Promise(r=>setTimeout(r,50));
const bText=shown();
ok('full country names now RESOLVE to cards', cards()===2 && /Czech Republic/.test(bText), bText.slice(0,70));
ok('  → not the empty state', !/could not produce usable recommendations/i.test(bText));

console.log('\n═══ C. Lowercase codes ═══');
w.document.getElementById('recResultsList').textContent='';
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'cz',country_name:'Czech Republic',match_score:0.8,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'x',monthly_cost_estimate_eur:1500}]})});
fillForm(); await w.submitRecommender(); await new Promise(r=>setTimeout(r,50));
ok('lowercase codes tolerated (uppercased)', cards()>=1, shown().slice(0,70));

console.log('\n═══ D. UK/GB and Czechia naming drift ═══');
w.document.getElementById('recResultsList').textContent='';
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'UK',country_name:'United Kingdom',match_score:0.7,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'Skilled Worker',monthly_cost_estimate_eur:3000}]})});
fillForm(); await w.submitRecommender(); await new Promise(r=>setTimeout(r,50));
ok('"UK" alias resolves to GB', cards()===1 && /United Kingdom/.test(shown()), shown().slice(0,70));
ok('  → not the empty state', !/could not produce/i.test(shown()));

console.log('\n═══ E. Genuinely unresolvable destination ═══');
w.document.getElementById('recResultsList').textContent='';
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'Atlantis',country_name:'Atlantis',match_score:0.9,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'x',monthly_cost_estimate_eur:1}]})});
fillForm(); await w.submitRecommender(); await new Promise(r=>setTimeout(r,50));
ok('unknown country still safely dropped', /could not produce usable recommendations/i.test(shown()));

console.log('\n═══ F. Mixed valid + invalid ═══');
w.document.getElementById('recResultsList').textContent='';
w.fetch=async()=>({ok:true,status:200,json:async()=>({recommendations:[
 {rank:1,country:'Atlantis',country_name:'Atlantis',match_score:0.9,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'x',monthly_cost_estimate_eur:1},
 {rank:2,country:'Czechia',country_name:'Czechia',match_score:0.8,rationale:'r',key_advantages:['a'],considerations:['c'],visa_route:'Employee Card',monthly_cost_estimate_eur:1500}]})});
fillForm(); await w.submitRecommender(); await new Promise(r=>setTimeout(r,50));
ok('valid item survives, invalid dropped', cards()===1 && /Czech/.test(shown()), shown().slice(0,60));

console.log('\nPASS '+p+'  FAIL '+f);
})();
