/* Seed 5 demo partner submissions */
(async () => {
  const base = process.env.API_URL || 'http://localhost:4000';
  const email = process.env.DEMO_PARTNER_EMAIL || 'demo.partner@satvic.local';
  const password = process.env.DEMO_PARTNER_PASSWORD || 'Demo123!';
  const headers = { 'Content-Type': 'application/json' };
  async function post(path, body, authToken) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: authToken ? { ...headers, Authorization: `Bearer ${authToken}` } : headers,
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }
  async function get(path) {
    const res = await fetch(`${base}${path}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }
  let token;
  try {
    const reg = await post('/api/auth/partner/register', { email, password, name: 'Demo Partner', phone: '9999990000' });
    token = reg.token;
  } catch (e) {
    const login = await post('/api/auth/partner/login', { email, password });
    token = login.token;
  }
  const submissions = [
    {
      profile: { name: 'Anand Satvik Kitchen', city: 'Jaipur', phone: '9000001001', street: '12 Peace Lane', state: 'Rajasthan', pincode: '302001', vegStatus: 'Pure Satvik', jainFriendly: true, hours: '11am - 10pm' },
      menuItems: [
        { name: 'Paneer Satvik Curry', description: 'Clean spices, no onion/garlic', price: 280, category: 'Main' },
        { name: 'Khichdi', description: 'Comfort sattvic', price: 120, category: 'Main' },
      ],
      offers: [{ title: 'Opening Week', discountPct: 10 }],
    },
    {
      profile: { name: 'Shuddh Bhojan House', city: 'Ahmedabad', phone: '9000001002', street: '45 Harmony Street', state: 'Gujarat', pincode: '380001', vegStatus: 'No Onion/Garlic', jainFriendly: false, hours: '12pm - 9pm' },
      menuItems: [
        { name: 'Dal-Rice', description: 'Simple and pure', price: 150, category: 'Main' },
        { name: 'Sabudana Khichdi', description: 'Fasting special', price: 130, category: 'Snacks' },
      ],
      offers: [],
    },
    {
      profile: { name: 'Jain Vihar Cafe', city: 'Mumbai', phone: '9000001003', street: '7 Tranquil Rd', state: 'Maharashtra', pincode: '400001', vegStatus: 'Pure Satvik', jainFriendly: true, hours: '10am - 10pm' },
      menuItems: [
        { name: 'Jain Thali', description: 'No onion/garlic, wholesome', price: 220, category: 'Thali' },
        { name: 'Fruit Bowl', description: 'Seasonal fresh fruits', price: 150, category: 'Dessert' },
      ],
      offers: [{ title: 'Lunch Combo', discountPct: 15 }],
    },
    {
      profile: { name: 'Prana Greens', city: 'Bengaluru', phone: '9000001004', street: '99 Serenity Ave', state: 'Karnataka', pincode: '560001', vegStatus: 'No Onion/Garlic', jainFriendly: true, hours: '9am - 9pm' },
      menuItems: [
        { name: 'Millet Bowl', description: 'Nutritious grains', price: 200, category: 'Bowl' },
        { name: 'Satvik Pongal', description: 'Comfort meal', price: 160, category: 'Main' },
      ],
      offers: [],
    },
    {
      profile: { name: 'Sattva Spice', city: 'Pune', phone: '9000001005', street: '18 Bliss Path', state: 'Maharashtra', pincode: '411001', vegStatus: 'Pure Satvik', jainFriendly: false, hours: '11am - 11pm' },
      menuItems: [
        { name: 'Veg Stew', description: 'Light and clean', price: 210, category: 'Main' },
        { name: 'Moong Dal', description: 'Protein-rich', price: 140, category: 'Main' },
      ],
      offers: [{ title: 'Evening Special', discountPct: 12 }],
    },
  ];
  const results = [];
  for (const s of submissions) {
    const r = await post('/api/partners', s, token);
    results.push(r);
  }
  const current = await get('/api/partners');
  console.log(`Seeded submissions: ${results.length}. Total partners now: ${current.length}`);
})().catch((e) => {
  console.error('Seed error:', e.message);
  process.exitCode = 1;
});
