// netlify/functions/recommend-destination.js
//
// Reverse search: given a user profile, return top 3 destination recommendations
// with personalised rationale.
//
// Required env vars (set in Netlify dashboard → Site configuration → Environment):
//   ANTHROPIC_API_KEY    — sk-ant-... from console.anthropic.com
//
// Public endpoint — no auth required (free feature, drives signup conversion).
// Light rate limiting recommended via Netlify Edge config if abuse appears.

const destinationProfiles = require('./destination-profiles');

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-5-20250929';

exports.handler = async function (event) {
  // CORS for fetch from relociq.app
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Method not allowed' }) };

  let profile;
  try { profile = JSON.parse(event.body || '{}'); }
  catch (_) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const required = ['nationality', 'role'];
  for (const k of required) {
    if (!profile[k]) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Missing field: ${k}` }) };
  }

  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(profile);

  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
        // Force JSON output via tool use
        tools: [{
          name: 'submit_recommendations',
          description: 'Submit the ranked destination recommendations.',
          input_schema: {
            type: 'object',
            properties: {
              recommendations: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    rank: { type: 'integer', minimum: 1, maximum: 3 },
                    country: { type: 'string', description: 'Two-letter ISO code matching the destination list' },
                    country_name: { type: 'string' },
                    match_score: { type: 'number', minimum: 0, maximum: 1 },
                    rationale: { type: 'string', description: '2-3 sentence personalised explanation' },
                    key_advantages: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4 },
                    considerations: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 3 },
                    visa_route: { type: 'string' },
                    monthly_cost_estimate_eur: { type: 'integer' }
                  },
                  required: ['rank', 'country', 'country_name', 'match_score', 'rationale', 'key_advantages', 'considerations', 'visa_route', 'monthly_cost_estimate_eur']
                },
                minItems: 3,
                maxItems: 3
              }
            },
            required: ['recommendations']
          }
        }],
        tool_choice: { type: 'tool', name: 'submit_recommendations' }
      })
    });

    if (!res.ok) {
      const text = await res.text();
      console.error('Anthropic API error:', res.status, text);
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Recommendation service unavailable' }) };
    }

    const data = await res.json();
    const toolUse = (data.content || []).find(b => b.type === 'tool_use');
    if (!toolUse || !toolUse.input) {
      console.error('No tool_use in response:', JSON.stringify(data).slice(0, 500));
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Malformed recommendation response' }) };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(toolUse.input)
    };

  } catch (err) {
    console.error('Recommend handler error:', err);
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Internal error' }) };
  }
};

function buildSystemPrompt() {
  return `You are Relociq's immigration relocation advisor. Given a user's profile, you recommend the 3 best destinations from this set of 18 countries: Czech Republic (CZ), Poland (PL), Belgium (BE), Sweden (SE), Singapore (SG), France (FR), United States (US), Ireland (IE), Austria (AT), Italy (IT), Netherlands (NL), Portugal (PT), United Arab Emirates (AE), Australia (AU), United Kingdom (GB), Spain (ES), Canada (CA), Germany (DE).

Destination profile data (current as of 2026):
${JSON.stringify(destinationProfiles, null, 2)}

Your reasoning process:
1. Identify the user's visa-tier from their nationality (EU citizen → freedom of movement to other EU, others → specific work visa routes).
2. Match their role and salary to destination salary thresholds (reject destinations where they can't meet the gross minimum).
3. Match their language skills to destinations where they can actually work without years of language learning.
4. Weight their priorities (career growth, cost, lifestyle, family, climate, taxes) appropriately.
5. Return 3 destinations ranked 1-3 with personalised rationale.

Rules:
- Never recommend a destination they fundamentally cannot access (e.g. US for someone with no chance at H-1B and no O-1 case).
- Be honest about trade-offs in the considerations field.
- Match score is 0-1, where 1 is a near-perfect match.
- Rationale must reference at least 2 specific things from their profile.
- Monthly cost estimate should be in EUR for a comfortable single-person budget in the destination's primary expat city.
- visa_route should name the specific visa path (e.g. "EU Blue Card", "Employee Card", "Talent Passport").

Call the submit_recommendations tool with your output.`;
}

function buildUserMessage(profile) {
  const fields = [];
  if (profile.nationality) fields.push(`- Nationality: ${profile.nationality}`);
  if (profile.current_location) fields.push(`- Current location: ${profile.current_location}`);
  if (profile.role) fields.push(`- Role / field: ${profile.role}`);
  if (profile.salary_usd) fields.push(`- Current annual salary: ~$${profile.salary_usd.toLocaleString()} USD`);
  if (Array.isArray(profile.languages) && profile.languages.length) fields.push(`- Languages spoken: ${profile.languages.join(', ')}`);
  if (typeof profile.partner === 'boolean') fields.push(`- Partner moving too: ${profile.partner ? 'yes' : 'no'}`);
  if (typeof profile.children === 'number') fields.push(`- Children: ${profile.children}`);
  if (Array.isArray(profile.priorities) && profile.priorities.length) fields.push(`- Stated priorities (in rank order): ${profile.priorities.join(' > ')}`);
  if (profile.notes) fields.push(`- Additional context: ${String(profile.notes).slice(0, 500)}`);

  return `Recommend the best 3 destinations for this user:\n\n${fields.join('\n')}`;
}
