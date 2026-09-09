const { test } = require('node:test');
const assert = require('node:assert/strict');
const { handler } = require('../netlify/functions/recommend-destination');
const recommendation = {rank:1,country:'DE',country_name:'Germany',match_score:0.8,rationale:'Profile-specific explanation',key_advantages:['One','Two'],considerations:['Caveat'],visa_route:'Example route',monthly_cost_estimate_eur:2000};
const good = () => ({stop_reason:'tool_use',usage:{input_tokens:100,output_tokens:200},content:[{type:'tool_use',name:'submit_recommendations',input:{recommendations:[{...recommendation}]}}]});
const event = value => ({httpMethod:'POST',body:JSON.stringify(value)});
const profile = {nationality:'IN',role:'security analyst'};
test('recommender response and failure contracts', async t => {
 const originalFetch=global.fetch, originalKey=process.env.ANTHROPIC_API_KEY;
 const originalLog=console.log; const logs=[]; console.log=x=>logs.push(x);
 let calls=0;
 const mock = data => {global.fetch=async (_url, opts)=>{calls++;const body=JSON.parse(opts.body);assert.equal(body.max_tokens,2000);assert.ok(opts.signal);return {ok:true,json:async()=>data};};};
 process.env.ANTHROPIC_API_KEY='test-placeholder';
 try {
  await t.test('valid output preserves frontend contract',async()=>{mock(good());const r=await handler(event(profile));assert.equal(r.statusCode,200);assert.equal(JSON.parse(r.body).recommendations[0].country,'DE');assert.ok(r.headers['X-Relociq-Request-Id']);});
  await t.test('null, array, invalid JSON, blank role, invalid nationality and large body never call upstream',async()=>{const before=calls;for(const e of [event(null),event([]),{httpMethod:'POST',body:'{'},event({...profile,role:' '}),event({...profile,nationality:['IN']}),event({...profile,notes:'x'.repeat(17000)})]){assert.ok([400,413].includes((await handler(e)).statusCode));}assert.equal(calls,before);});
  await t.test('missing key fails before upstream',async()=>{delete process.env.ANTHROPIC_API_KEY;const before=calls;assert.equal((await handler(event(profile))).statusCode,503);assert.equal(calls,before);process.env.ANTHROPIC_API_KEY='test-placeholder';});
  await t.test('truncation is explicit even when partial object is parseable',async()=>{const d=good();d.stop_reason='max_tokens';mock(d);assert.equal(JSON.parse((await handler(event(profile))).body).code,'OUTPUT_TRUNCATED');});
  await t.test('missing, wrong-name, malformed, duplicate and unknown-country output rejected',async()=>{
   const samples=[null,{content:{}}, {stop_reason:'end_turn',content:[]}, good(),good(),good(),good(),good()];
   samples[3].content[0].name='other';samples[4].content[0].input.recommendations[0].country='XX';samples[5].content[0].input.recommendations=[];samples[6].content[0].input.recommendations.push({...recommendation,rank:2});samples[7].content[0].input.recommendations[0].match_score=2;
   for(const d of samples){mock(d);const r=await handler(event(profile));assert.equal(r.statusCode,502);assert.equal(JSON.parse(r.body).code,'INVALID_MODEL_OUTPUT');}
  });
  await t.test('429 and 529 are busy, upstream 401 is distinguishable',async()=>{for(const status of [429,529,401]){global.fetch=async()=>({ok:false,status});const r=await handler(event(profile));assert.equal(r.statusCode,status===401?502:503);}});
  await t.test('invalid upstream JSON and network failure are controlled',async()=>{global.fetch=async()=>({ok:true,json:async()=>{throw new SyntaxError('private payload');}});assert.equal(JSON.parse((await handler(event(profile))).body).code,'UPSTREAM_INVALID_JSON');global.fetch=async()=>{throw new Error('private payload');};assert.equal(JSON.parse((await handler(event(profile))).body).code,'UPSTREAM_NETWORK_ERROR');});
  await t.test('upstream abort maps to timeout',async()=>{global.fetch=async()=>{throw Object.assign(new Error('aborted'),{name:'AbortError'});};assert.equal((await handler(event(profile))).statusCode,504);});
  await t.test('OPTIONS and wrong method never fetch',async()=>{global.fetch=async()=>{assert.fail('must not fetch');};assert.equal((await handler({httpMethod:'OPTIONS'})).statusCode,200);assert.equal((await handler({httpMethod:'GET'})).statusCode,405);});
  await t.test('logs omit profile, provider body and key',()=>{const text=logs.join('\n');for(const secret of ['security analyst','private payload','test-placeholder'])assert.ok(!text.includes(secret));assert.ok(text.includes('upstream_complete'));});
 } finally {global.fetch=originalFetch;console.log=originalLog;if(originalKey===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=originalKey;}
});
