const SHOP = 'adriencardot.myshopify.com';
const API_VERSION = '2024-10';
const ALLOWED_ORIGINS = [
  'https://adriencardot.myshopify.com',
  'https://adriencardot.com',
  'https://www.adriencardot.com'
];

function cors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getToken() {
  const r = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      grant_type: 'client_credentials'
    })
  });
  const data = await r.json();
  return data.access_token;
}

async function shopifyAdmin(token, endpoint, method, body) {
  const r = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/${endpoint}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: r.status, data: await r.json() };
}

function buildNote(fields) {
  const date = new Date().toLocaleDateString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  let note = `Formulaire contact — ${date}\n`;
  for (const [key, value] of Object.entries(fields)) {
    if (value && value.trim()) {
      note += `• ${key} : ${value.trim()}\n`;
    }
  }
  return note;
}

function sanitizeEmail(contactValue) {
  const v = (contactValue || '').trim();
  if (v.includes('@') && v.includes('.')) return v;
  const clean = v.replace(/[\s.+()/-]/g, '').replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
  return `${clean}@contact.adriencardot.fr`;
}

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    // Support both application/json and text/plain (sendBeacon)
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ error: 'Invalid JSON' }); }
    }
    const { contact, fields, source } = body;
    if (!contact) return res.status(400).json({ error: 'Missing contact field' });

    const email = sanitizeEmail(contact);
    const tags = ['contact-form', source || 'homepage'].filter(Boolean);

    // Add key fields to tags for easy filtering in admin
    if (fields['Quel service vous intéresse ?']) {
      tags.push(fields['Quel service vous intéresse ?']);
    }
    if (fields['Budget estimé']) {
      tags.push(fields['Budget estimé']);
    }

    const note = buildNote(fields);
    const token = await getToken();

    // Check if customer already exists
    const search = await shopifyAdmin(token, `customers/search.json?query=email:${encodeURIComponent(email)}`, 'GET');
    const existing = search.data?.customers?.[0];

    if (existing) {
      // Append to existing note
      const updatedNote = existing.note
        ? `${existing.note}\n\n---\n\n${note}`
        : note;
      const existingTags = existing.tags ? existing.tags.split(', ') : [];
      const mergedTags = [...new Set([...existingTags, ...tags])];

      await shopifyAdmin(token, `customers/${existing.id}.json`, 'PUT', {
        customer: {
          id: existing.id,
          note: updatedNote,
          tags: mergedTags.join(', ')
        }
      });
      return res.status(200).json({ ok: true, action: 'updated', id: existing.id });
    }

    // Create new customer
    const result = await shopifyAdmin(token, 'customers.json', 'POST', {
      customer: {
        email,
        tags: tags.join(', '),
        note,
        verified_email: true,
        email_marketing_consent: {
          state: 'subscribed',
          opt_in_level: 'single_opt_in'
        }
      }
    });

    if (result.status === 201 || result.status === 200) {
      return res.status(200).json({ ok: true, action: 'created', id: result.data.customer?.id });
    }

    return res.status(result.status).json({ ok: false, errors: result.data.errors });
  } catch (err) {
    console.error('Customer creation error:', err);
    return res.status(500).json({ error: 'Internal error' });
  }
}
