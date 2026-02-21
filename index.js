require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const streamifier = require('streamifier');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// So you can confirm the right server is running: GET /api/ping → { "pong": true }
app.get('/api/ping', (req, res) => res.json({ pong: true }));

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer memory storage to accept file uploads
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const MONGO_URI = process.env.MONGO_URI;
const PORT = process.env.PORT || 4000;

const mailer = (() => {
  const host = process.env.BREVO_SMTP_HOST || 'smtp-relay.brevo.com';
  const port = Number(process.env.BREVO_SMTP_PORT || 587);
  const user = process.env.BREVO_SMTP_USER;
  const pass = process.env.BREVO_SMTP_PASS;
  const from = process.env.BREVO_FROM || 'no-reply@satvic.local';
  if (!user || !pass) return null;
  const transporter = nodemailer.createTransport({ host, port, secure: false, auth: { user, pass } });
  return async (to, subject, text, html) => {
    try {
      await transporter.sendMail({ from, to, subject, text, html: html || `<pre>${text}</pre>` });
      return true;
    } catch (e) {
      console.warn('Email send error:', e.message);
      return false;
    }
  };
})();

const restaurantSchema = new mongoose.Schema({
  name: String,
  address: String,
  city: String,
  area: String,
  latitude: Number,
  longitude: Number,
  verified: { type: Boolean, default: false },
  satvikType: { type: String, enum: ['Pure Satvik', 'No Onion/Garlic', 'Jain Friendly'] },
  priceRange: { type: String, enum: ['$', '$$', '$$$'] },
  menu: [{ name: String, description: String, price: Number, category: String, imageUrl: String }],
  story: String,
  bestTimeToVisit: String,
  coverImage: String,
  ownerEmail: String,
});

const partnerSubmissionSchema = new mongoose.Schema({
  profile: { type: Object, required: true },
  menuItems: { type: Array, default: [] },
  offers: { type: Array, default: [] },
  status: { type: String, default: 'pending' },
  createdAt: { type: Date, default: Date.now },
})
const PartnerSubmission = mongoose.models.PartnerSubmission || mongoose.model('PartnerSubmission', partnerSubmissionSchema)
const inMemorySubmissions = []

const Restaurant = mongoose.models.Restaurant || mongoose.model('Restaurant', restaurantSchema);
const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, index: true },
  passwordHash: String,
  salt: String,
  role: { type: String, enum: ['admin', 'partner', 'user'], default: 'partner' },
  name: String,
  phone: String,
  resetToken: String,
  resetExpires: Date,
  verified: { type: Boolean, default: false },
  otpCode: String,
  otpExpires: Date,
  resetOtpCode: String,
  resetOtpExpires: Date,
})
const User = mongoose.models.User || mongoose.model('User', userSchema)
const JWT_SECRET = process.env.JWT_SECRET || 'satvic_dev_secret'

const orderSchema = new mongoose.Schema({
  restaurantId: mongoose.Schema.Types.ObjectId,
  restaurantName: String,
  ownerEmail: String,
  userId: mongoose.Schema.Types.ObjectId,
  items: [{ name: String, qty: Number, price: Number }],
  contactName: String,
  tableNo: String,
  contactEmail: String,
  contactPhone: String,
  notes: String,
  status: { type: String, enum: ['pending', 'processing', 'served', 'cancelled'], default: 'pending' },
  rating: { type: Number, min: 1, max: 5 },
  feedback: String,
  feedbackAt: { type: Date },
  createdAt: { type: Date, default: Date.now },
})
const Order = mongoose.models.Order || mongoose.model('Order', orderSchema)
const inMemoryOrders = []

// SSE: partner email -> list of response objects for live order updates
const partnerOrderStreams = new Map()
function ensureAuthQueryToken(role) {
  return (req, res, next) => {
    try {
      const token = req.query.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      if (!token) return res.status(401).json({ error: 'Unauthorized' })
      const payload = jwt.verify(token, JWT_SECRET)
      if (role && payload.role !== role) return res.status(403).json({ error: 'Forbidden' })
      req.user = payload
      next()
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }
}
function notifyPartnerNewOrder(ownerEmail) {
  if (!ownerEmail) return
  const conns = partnerOrderStreams.get(ownerEmail)
  if (!conns || conns.length === 0) return
  const payload = JSON.stringify({ event: 'new_order', at: new Date().toISOString() })
  conns.forEach((res) => {
    try {
      res.write(`event: new_order\ndata: ${payload}\n\n`)
      if (typeof res.flush === 'function') res.flush()
    } catch (e) {
      console.warn('SSE write error:', e.message)
    }
  })
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, s, 64).toString('hex')
  return { hash, salt: s }
}
function verifyPassword(password, hash, salt) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex')
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'))
}
function issueToken(user) {
  return jwt.sign({ uid: String(user._id), role: user.role }, JWT_SECRET, { expiresIn: '7d' })
}
function ensureAuth(role) {
  return (req, res, next) => {
    try {
      const auth = req.headers.authorization || ''
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
      if (!token) return res.status(401).json({ error: 'Unauthorized' })
      const payload = jwt.verify(token, JWT_SECRET)
      if (role && payload.role !== role) return res.status(403).json({ error: 'Forbidden' })
      req.user = payload
      next()
    } catch {
      return res.status(401).json({ error: 'Unauthorized' })
    }
  }
}

// Register /api/my-orders first so it is never shadowed (user orders)
app.get('/api/my-orders', ensureAuth('user'), async (req, res) => {
  try {
    const uid = req.user.uid
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const uids = [uid]
      if (mongoose.Types.ObjectId.isValid(uid) && String(uid).length === 24) {
        try { uids.push(new mongoose.Types.ObjectId(uid)) } catch (e) {}
      }
      const list = await Order.find({ userId: { $in: uids } }).sort({ createdAt: -1 }).lean()
      return res.json(list)
    }
    res.json(inMemoryOrders.filter((o) => String(o.userId) === String(uid)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

async function connectMongo() {
  if (!MONGO_URI) {
    console.warn('No MONGO_URI provided. Server will run with in-memory sample data.');
    return;
  }
  try {
    await mongoose.connect(MONGO_URI, { dbName: process.env.DB_NAME || undefined });
    console.log('Connected to MongoDB Atlas');
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      const existing = await User.findOne({ role: 'admin' }).lean()
      if (!existing) {
        const { hash, salt } = hashPassword(process.env.ADMIN_PASSWORD)
        await User.create({ email: process.env.ADMIN_EMAIL, passwordHash: hash, salt, role: 'admin', name: 'Admin' })
      }
    }
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

// Haversine distance (km)
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

async function getRatingsMap() {
  try {
    if (mongoose.connection.readyState === 1 && MONGO_URI) {
      const groups = await Order.aggregate([
        { $match: { status: 'served', rating: { $gte: 1 } } },
        { $group: { _id: '$restaurantId', avg: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]);
      const map = {};
      for (const g of groups) {
        map[String(g._id)] = { avg: Math.round((g.avg || 0) * 10) / 10, count: g.count || 0 };
      }
      return map;
    }
    const map = {};
    const list = inMemoryOrders.filter((o) => (o.status === 'served') && (Number(o.rating) >= 1));
    for (const o of list) {
      const rid = String(o.restaurantId);
      if (!map[rid]) map[rid] = { sum: 0, count: 0 };
      map[rid].sum += Number(o.rating) || 0;
      map[rid].count += 1;
    }
    const out = {};
    Object.keys(map).forEach((rid) => {
      const { sum, count } = map[rid];
      out[rid] = { avg: Math.round(((sum / (count || 1)) || 0) * 10) / 10, count };
    });
    return out;
  } catch {
    return {};
  }
}

const sampleData = [
  {
    _id: '1',
    name: 'Satvic Taste Sagar',
    address: '12 Peace Lane, Old Town',
    city: 'Jaipur',
    area: 'Old Town',
    latitude: 26.9124,
    longitude: 75.7873,
    verified: true,
    satvikType: 'Pure Satvik',
    priceRange: 250,
    menu: [
      { name: 'Khichdi', description: 'Simple, sattvic comfort food', price: 120 },
      { name: 'Fruit Bowl', description: 'Seasonal fresh fruits', price: 150 }
    ],
    story: 'Founded by spiritual seekers to serve clean food.',
    bestTimeToVisit: 'Evenings 6-8pm',
  },
  {
    _id: '2',
    name: 'Jain Bhojanalaya',
    address: '45 Harmony Street, City Center',
    city: 'Ahmedabad',
    area: 'City Center',
    latitude: 23.0225,
    longitude: 72.5714,
    verified: true,
    satvikType: 'Jain Friendly',
    priceRange: 220,
    menu: [
      { name: 'Jain Thali', description: 'No onion/garlic, simple and pure', price: 200 },
      { name: 'Dal-Rice', description: 'Clean and nutritious', price: 150 }
    ],
    story: 'Serving Jain-friendly meals for decades.',
    bestTimeToVisit: 'Lunch 12-2pm',
  }
];

function getModel() {
  if (mongoose.connection.readyState === 1 && MONGO_URI) {
    return Restaurant;
  }
  // In-memory fallback using sample data
  return {
    async find(query = {}) {
      const verifiedOnly = query.verified === true;
      let results = sampleData.filter((r) => (verifiedOnly ? r.verified : true));
      if (query.city) {
        results = results.filter((r) => r.city.toLowerCase() === String(query.city).toLowerCase());
      }
      if (query.satvikType) {
        results = results.filter((r) => r.satvikType === query.satvikType);
      }
      return results;
    },
    async findById(id) {
      return sampleData.find((r) => r._id === id) || null;
    }
  };
}

app.get('/api/restaurants', async (req, res) => {
  try {
    const { city, satvikType, q } = req.query;
    const query = { verified: true };
    if (city) query.city = city;
    if (satvikType) query.satvikType = satvikType;
    let results;
    if (mongoose.connection.readyState === 1 && MONGO_URI) {
      results = await Restaurant.find(query).lean();
    } else {
      const Model = getModel();
      results = await Model.find(query);
    }

    if (q) {
      const ql = String(q).toLowerCase();
      results = results.filter((r) => r.name.toLowerCase().includes(ql) || r.area.toLowerCase().includes(ql));
    }

    const ratings = await getRatingsMap();
    const withRatings = results.map((r) => {
      const id = String(r._id || r.id);
      const stats = ratings[id] || { avg: 0, count: 0 };
      return { ...r, _id: id, ratingAvg: stats.avg, ratingCount: stats.count };
    });
    res.json(withRatings);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/restaurants/nearby', async (req, res) => {
  const { lat, lng } = req.query;
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res.status(400).json({ error: 'lat and lng are required' });
  }
  try {
    let all;
    if (mongoose.connection.readyState === 1 && MONGO_URI) {
      all = await Restaurant.find({ verified: true }).lean();
    } else {
      const Model = getModel();
      all = await Model.find({ verified: true });
    }
    const ratings = await getRatingsMap();
    const withDistance = all.map((r) => {
      const id = String(r._id || r.id);
      const stats = ratings[id] || { avg: 0, count: 0 };
      return {
        ...r,
        _id: id,
        ratingAvg: stats.avg,
        ratingCount: stats.count,
        distanceKm: distanceKm(latitude, longitude, r.latitude, r.longitude),
      };
    });
    withDistance.sort((a, b) => a.distanceKm - b.distanceKm);
    res.json(withDistance);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public reviews for a restaurant (must be before /api/restaurants/:id)
app.get('/api/restaurants/:id/reviews', async (req, res) => {
  try {
    const rid = req.params.id;
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const list = await Order.find({
        restaurantId: mongoose.Types.ObjectId.isValid(rid) ? new mongoose.Types.ObjectId(rid) : rid,
        status: 'served',
        rating: { $exists: true, $gte: 1 }
      }).sort({ feedbackAt: -1 }).limit(50).lean();
      return res.json(list.map((o) => ({
        orderId: o._id,
        rating: o.rating,
        feedback: o.feedback || '',
        feedbackAt: o.feedbackAt,
        createdAt: o.createdAt
      })));
    }
    const list = inMemoryOrders.filter(
      (o) => String(o.restaurantId) === String(rid) && (o.status === 'served') && o.rating >= 1
    ).sort((a, b) => new Date(b.feedbackAt || b.createdAt) - new Date(a.feedbackAt || a.createdAt)).slice(0, 50);
    return res.json(list.map((o) => ({
      orderId: o._id || o.id,
      rating: o.rating,
      feedback: o.feedback || '',
      feedbackAt: o.feedbackAt,
      createdAt: o.createdAt
    })));
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/restaurants/:id', async (req, res) => {
  try {
    const Model = getModel();
    const restaurant = await Model.findById(req.params.id);
    if (!restaurant || restaurant.verified !== true) {
      return res.status(404).json({ error: 'Not found' });
    }
    res.json(restaurant);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/restaurants/:id', ensureAuth('admin'), async (req, res) => {
  try {
    const allowed = ['name','address','city','area','latitude','longitude','satvikType','priceRange','story','bestTimeToVisit','coverImage','menu']
    const update = {}
    for (const k of allowed) {
      if (req.body[k] !== undefined) update[k] = req.body[k]
    }
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const updated = await Restaurant.findByIdAndUpdate(req.params.id, update, { new: true })
      if (!updated) return res.status(404).json({ error: 'Not found' })
      return res.json(updated)
    }
    const idx = sampleData.findIndex((r) => r._id === String(req.params.id))
    if (idx === -1) return res.status(404).json({ error: 'Not found' })
    sampleData[idx] = { ...sampleData[idx], ...update }
    return res.json(sampleData[idx])
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.delete('/api/restaurants/:id', ensureAuth('admin'), async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const deleted = await Restaurant.findByIdAndDelete(req.params.id)
      if (!deleted) return res.status(404).json({ error: 'Not found' })
      return res.json({ ok: true })
    }
    const idx = sampleData.findIndex((r) => r._id === String(req.params.id))
    if (idx === -1) return res.status(404).json({ error: 'Not found' })
    sampleData.splice(idx, 1)
    return res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

app.get('/', (req, res) => {
  res.send('Satvic Taste API running');
});

// Cloudinary upload endpoint
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return res.status(500).json({ error: 'Cloudinary not configured' });
    }
    // Upload buffer to Cloudinary using upload_stream
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: 'satvic/partner' }, (error, uploadResult) => {
        if (error) return reject(error);
        resolve(uploadResult);
      });
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });
    return res.status(200).json({ url: result.secure_url, public_id: result.public_id });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: 'Upload failed' });
  }
});

app.post('/api/partners', ensureAuth('partner'), async (req, res) => {
  try {
    const { profile, menuItems, offers } = req.body || {}
    if (!profile?.name || !profile?.city || !profile?.phone || !Array.isArray(menuItems) || menuItems.length === 0) {
      return res.status(400).json({ error: 'Missing required fields: name, city, phone, at least one menu item' })
    }

    // If Mongo connected, persist; otherwise, in-memory
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const doc = await PartnerSubmission.create({ profile, menuItems, offers, status: 'pending' })
      return res.status(201).json({ id: String(doc._id), status: doc.status })
    } else {
      const id = String(Date.now())
      inMemorySubmissions.push({ id, profile, menuItems, offers, status: 'pending', createdAt: new Date() })
      return res.status(201).json({ id, status: 'pending' })
    }
  } catch (e) {
    console.error('Partner submit error:', e.message)
    return res.status(500).json({ error: 'Server error' })
  }
})

app.put('/api/partners/:id', ensureAuth('partner'), async (req, res) => {
  try {
    const { id } = req.params
    const { profile, menuItems, offers } = req.body || {}
    // Allow partial updates from partner dashboard; admin will validate at approval
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const updated = await PartnerSubmission.findByIdAndUpdate(id, { profile, menuItems, offers }, { new: true })
      if (!updated) return res.status(404).json({ error: 'Submission not found' })
      return res.json({ id: String(updated._id), status: updated.status || 'pending' })
    } else {
      const idx = inMemorySubmissions.findIndex((s) => s.id === id)
      if (idx === -1) return res.status(404).json({ error: 'Submission not found' })
      inMemorySubmissions[idx] = { ...inMemorySubmissions[idx], profile, menuItems, offers }
      return res.json({ id, status: inMemorySubmissions[idx].status || 'pending' })
    }
  } catch (e) {
    console.error('Partner update error:', e.message)
    return res.status(500).json({ error: 'Server error' })
  }
})
app.get('/api/partners', async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const list = await PartnerSubmission.find({}).sort({ createdAt: -1 }).lean()
      return res.json(list.map((d) => ({ id: String(d._id), profile: d.profile, menuItems: d.menuItems, offers: d.offers || [], status: d.status, createdAt: d.createdAt })))
    }
    res.json(inMemorySubmissions.map((s) => ({ id: s.id, profile: s.profile, menuItems: s.menuItems, offers: s.offers || [], status: s.status, createdAt: s.createdAt })))
  } catch (e) {
    console.error('Partners list error:', e.message)
    res.status(500).json({ error: 'Server error' })
  }
})

function buildAddress(profile) {
  const parts = [profile.street, profile.city, profile.state, profile.pincode].filter(Boolean)
  return parts.join(', ') || profile.city || ''
}

app.post('/api/partners/:id/approve', ensureAuth('admin'), async (req, res) => {
  try {
    const { id } = req.params
    let submission
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      submission = await PartnerSubmission.findById(id).lean()
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
    } else {
      submission = inMemorySubmissions.find((s) => s.id === id)
      if (!submission) return res.status(404).json({ error: 'Submission not found' })
    }
    const { profile, menuItems } = submission
    const RestaurantModel = mongoose.connection.readyState === 1 ? Restaurant : null
    const coverImage = profile.coverImage || (menuItems || []).find((m) => m.imageDataUrl)?.imageDataUrl
    const restaurantData = {
      name: profile.name || 'Restaurant',
      address: buildAddress(profile),
      city: profile.city || '',
      area: profile.area || profile.city || '',
      latitude: profile.latitude != null && profile.latitude !== '' ? Number(profile.latitude) : undefined,
      longitude: profile.longitude != null && profile.longitude !== '' ? Number(profile.longitude) : undefined,
      verified: true,
      satvikType: profile.vegStatus === 'Pure Satvik' ? 'Pure Satvik' : profile.jainFriendly ? 'Jain Friendly' : 'No Onion/Garlic',
      priceRange: '$$',
      menu: (menuItems || []).map((m) => ({ name: m.name || '', description: m.description || '', price: Number(m.price) || 0, category: m.category || '', imageUrl: m.imageDataUrl || m.imageUrl || '' })),
      story: profile.notes || '',
      bestTimeToVisit: profile.hours || '',
      coverImage: coverImage || undefined,
      ownerEmail: profile.email || '',
    }
    if (RestaurantModel) {
      const created = await RestaurantModel.create(restaurantData)
      try {
        await PartnerSubmission.updateOne({ _id: submission._id }, { status: 'approved' })
      } catch (upErr) {
        console.warn('Update submission status:', upErr.message)
      }
      return res.json({ id: String(created._id), status: 'approved', restaurantId: String(created._id) })
    }
    sampleData.push({ ...restaurantData, _id: String(sampleData.length + 1) })
    const inMem = inMemorySubmissions.find((s) => s.id === id)
    if (inMem) inMem.status = 'approved'
    res.json({ id: submission.id, status: 'approved', restaurantId: String(sampleData.length) })
  } catch (e) {
    console.error('Approve error:', e.message)
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/auth/partner/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body || {}
    if (!email || !password) return res.status(400).json({ error: 'email and password required' })
    const exists = await User.findOne({ email }).lean()
    if (exists) return res.status(409).json({ error: 'email exists' })
    const { hash, salt } = hashPassword(password)
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000)
    const user = await User.create({ email, passwordHash: hash, salt, role: 'partner', name, phone, otpCode: code, otpExpires, verified: false })
    if (mailer) {
      await mailer(email, 'Verify your partner account', `Your OTP is ${code}. It expires in 10 minutes.`)
    }
    const token = issueToken(user)
    res.json({ token })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/partner/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}
    const user = await User.findOne({ email, role: 'partner' })
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    if (!verifyPassword(password, user.passwordHash, user.salt)) return res.status(401).json({ error: 'Invalid credentials' })
    const token = issueToken(user)
    res.json({ token })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/user/register', async (req, res) => {
  try {
    const { email, password, name, phone } = req.body || {}
    if (!email || !password) return res.status(400).json({ error: 'email and password required' })
    const exists = await User.findOne({ email }).lean()
    if (exists) return res.status(409).json({ error: 'email exists' })
    const { hash, salt } = hashPassword(password)
    const code = String(Math.floor(100000 + Math.random() * 900000))
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000)
    const user = await User.create({ email, passwordHash: hash, salt, role: 'user', name, phone, otpCode: code, otpExpires, verified: false })
    if (mailer) {
      await mailer(email, 'Verify your account', `Your OTP is ${code}. It expires in 10 minutes.`)
    }
    const token = issueToken(user)
    res.json({ token })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/user/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}
    const user = await User.findOne({ email, role: 'user' })
    if (!user) return res.status(401).json({ error: 'Invalid credentials' })
    if (!verifyPassword(password, user.passwordHash, user.salt)) return res.status(401).json({ error: 'Invalid credentials' })
    const token = issueToken(user)
    res.json({ token })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/verify-otp', async (req, res) => {
  try {
    const { email, role, code } = req.body || {}
    if (!email || !code) return res.status(400).json({ error: 'email and code required' })
    const user = await User.findOne({ email, role: role || { $in: ['partner', 'user'] } })
    if (!user || !user.otpCode || !user.otpExpires) return res.status(400).json({ error: 'Invalid code' })
    if (user.otpCode !== code || user.otpExpires < new Date()) return res.status(400).json({ error: 'Invalid code' })
    await User.updateOne({ _id: user._id }, { verified: true, otpCode: null, otpExpires: null })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/admin/login', async (req, res) => {
  try {
    const { email, password } = req.body || {}
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const user = await User.findOne({ email, role: 'admin' })
      if (!user) return res.status(401).json({ error: 'Invalid credentials' })
      if (!verifyPassword(password, user.passwordHash, user.salt)) return res.status(401).json({ error: 'Invalid credentials' })
      const token = issueToken(user)
      return res.json({ token })
    }
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
      const token = issueToken({ _id: 'dev-admin', role: 'admin' })
      return res.json({ token })
    }
    return res.status(401).json({ error: 'Invalid credentials' })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/request-reset', async (req, res) => {
  try {
    const { email } = req.body || {}
    const user = await User.findOne({ email })
    if (!user) return res.status(200).json({ ok: true })
    const token = crypto.randomBytes(32).toString('hex')
    const expires = new Date(Date.now() + 60 * 60 * 1000)
    const otp = String(Math.floor(100000 + Math.random() * 900000))
    const otpExpires = new Date(Date.now() + 10 * 60 * 1000)
    await User.updateOne({ _id: user._id }, { resetToken: token, resetExpires: expires, resetOtpCode: otp, resetOtpExpires: otpExpires })
    if (mailer) {
      await mailer(email, 'Password reset code', `Your reset OTP is ${otp}. It expires in 10 minutes.`)
    }
    res.json({ resetToken: token, expires })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, token, otp, newPassword } = req.body || {}
    const user = await User.findOne({ email })
    if (!user) return res.status(400).json({ error: 'Invalid request' })
    const tokenOk = token && user.resetToken === token && user.resetExpires && user.resetExpires >= new Date()
    const otpOk = otp && user.resetOtpCode === otp && user.resetOtpExpires && user.resetOtpExpires >= new Date()
    if (!tokenOk && !otpOk) return res.status(400).json({ error: 'Invalid token' })
    const { hash, salt } = hashPassword(newPassword)
    await User.updateOne({ _id: user._id }, { passwordHash: hash, salt, resetToken: null, resetExpires: null, resetOtpCode: null, resetOtpExpires: null })
    res.json({ ok: true })
  } catch {
    res.status(500).json({ error: 'Server error' })
  }
})

app.post('/api/orders', ensureAuth('user'), async (req, res) => {
  try {
    const { restaurantId, items, tableNo, contactEmail, contactPhone, contactName, notes } = req.body || {}
    if (!restaurantId || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'restaurantId and items required' })
    let restaurant
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      restaurant = await Restaurant.findById(restaurantId).lean()
    } else {
      restaurant = sampleData.find((r) => String(r._id) === String(restaurantId))
    }
    if (!restaurant) return res.status(404).json({ error: 'Restaurant not found' })
    const cleanItems = items.map((it) => ({ name: String(it.name || ''), qty: Number(it.qty || 1), price: Number(it.price || 0) }))
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const order = await Order.create({
        restaurantId: restaurant._id,
        restaurantName: restaurant.name,
        ownerEmail: restaurant.ownerEmail || '',
        userId: req.user.uid,
        items: cleanItems,
        contactName: contactName || '',
        tableNo: tableNo || '',
        contactEmail: contactEmail || '',
        contactPhone: contactPhone || '',
        notes: notes || '',
        status: 'pending',
      })
      if (mailer && restaurant.ownerEmail) {
        const lines = cleanItems.map((i) => `• ${i.name} x${i.qty} — ₹${i.price}`).join('\n')
        const text = `New order for ${restaurant.name}\nTable: ${tableNo || '-'}\nCustomer: ${contactName || ''}\nItems:\n${lines}\nContact: ${contactEmail || ''} ${contactPhone || ''}\nNotes: ${notes || ''}`
        await mailer(restaurant.ownerEmail, `New order — ${restaurant.name}`, text)
      }
      notifyPartnerNewOrder(restaurant.ownerEmail || '')
      return res.json({ id: String(order._id) })
    }
    const order = {
      id: String(Date.now()),
      restaurantId: restaurantId,
      restaurantName: restaurant.name,
      ownerEmail: restaurant.ownerEmail || '',
      userId: req.user.uid,
      items: cleanItems,
      contactName: contactName || '',
      tableNo: tableNo || '',
      contactEmail: contactEmail || '',
      contactPhone: contactPhone || '',
      notes: notes || '',
      status: 'pending',
      createdAt: new Date(),
    }
    inMemoryOrders.push(order)
    notifyPartnerNewOrder(restaurant.ownerEmail || '')
    return res.json({ id: order.id })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})
app.get('/api/orders', ensureAuth('admin'), async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const list = await Order.find({}).sort({ createdAt: -1 }).lean()
      return res.json(list)
    }
    res.json(inMemoryOrders.slice().sort((a, b) => b.createdAt - a.createdAt))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})
app.get('/api/orders/mine', ensureAuth('partner'), async (req, res) => {
  try {
    const user = await User.findById(req.user.uid).lean()
    const email = user?.email?.trim()
    if (!email) return res.json([])
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const escaped = String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const emailRegex = new RegExp(`^${escaped}$`, 'i')
      // Orders where ownerEmail matches (case-insensitive) OR restaurant belongs to this partner
      const restaurants = await Restaurant.find({ ownerEmail: emailRegex }).select('_id').lean()
      const rids = (restaurants || []).map((r) => r._id)
      const list = await Order.find({
        $or: [
          { ownerEmail: emailRegex },
          ...(rids.length ? [{ restaurantId: { $in: rids } }] : [])
        ]
      }).sort({ createdAt: -1 }).lean()
      return res.json(list)
    }
    const emailLower = email.toLowerCase()
    res.json(inMemoryOrders.filter((o) => (o.ownerEmail || '').toLowerCase() === emailLower).sort((a, b) => b.createdAt - a.createdAt))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// User order history (alternate path; main path is GET /api/my-orders registered above)
app.get('/api/orders/my', ensureAuth('user'), async (req, res) => {
  try {
    const uid = req.user.uid
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const uids = [uid]
      if (mongoose.Types.ObjectId.isValid(uid) && String(uid).length === 24) {
        try { uids.push(new mongoose.Types.ObjectId(uid)) } catch (e) {}
      }
      const list = await Order.find({ userId: { $in: uids } }).sort({ createdAt: -1 }).lean()
      return res.json(list)
    }
    res.json(inMemoryOrders.filter((o) => String(o.userId) === String(uid)).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)))
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// Partner: mark order as processing / served / cancelled (only their orders)
app.patch('/api/orders/:id/status', ensureAuth('partner'), async (req, res) => {
  try {
    const { id } = req.params
    const { status } = req.body || {}
    if (!['processing', 'served', 'cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
    const partnerUser = await User.findById(req.user.uid).lean()
    const email = partnerUser?.email?.trim()
    if (!email) return res.status(403).json({ error: 'Partner not found' })
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const order = await Order.findById(id).lean()
      if (!order) return res.status(404).json({ error: 'Order not found' })
      const ownerMatch = (order.ownerEmail || '').toLowerCase() === email.toLowerCase()
      if (!ownerMatch) return res.status(403).json({ error: 'Not your order' })
      await Order.updateOne({ _id: id }, { status })
      return res.json({ ok: true, status })
    }
    const order = inMemoryOrders.find((o) => String(o._id || o.id) === String(id))
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if ((order.ownerEmail || '').toLowerCase() !== email.toLowerCase()) return res.status(403).json({ error: 'Not your order' })
    order.status = status
    return res.json({ ok: true, status })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// User: submit rating (1–5) and feedback for a served order (transparent, shown publicly)
app.post('/api/orders/:id/feedback', ensureAuth('user'), async (req, res) => {
  try {
    const { id } = req.params
    const { rating, feedback } = req.body || {}
    const numRating = Math.min(5, Math.max(1, Number(rating) || 0))
    if (numRating < 1) return res.status(400).json({ error: 'Rating must be 1–5' })
    const uid = req.user.uid
    if (mongoose.connection.readyState === 1 && process.env.MONGO_URI) {
      const order = await Order.findById(id).lean()
      if (!order) return res.status(404).json({ error: 'Order not found' })
      const uidMatch = String(order.userId) === String(uid) || (mongoose.Types.ObjectId.isValid(uid) && String(order.userId) === String(new mongoose.Types.ObjectId(uid)))
      if (!uidMatch) return res.status(403).json({ error: 'Not your order' })
      if ((order.status || '') !== 'served') return res.status(400).json({ error: 'Can only rate after order is marked served' })
      await Order.updateOne(
        { _id: id },
        { rating: numRating, feedback: String(feedback || '').trim().slice(0, 2000), feedbackAt: new Date() }
      )
      return res.json({ ok: true })
    }
    const order = inMemoryOrders.find((o) => String(o._id || o.id) === String(id))
    if (!order) return res.status(404).json({ error: 'Order not found' })
    if (String(order.userId) !== String(uid)) return res.status(403).json({ error: 'Not your order' })
    if ((order.status || '') !== 'served') return res.status(400).json({ error: 'Can only rate after order is marked served' })
    order.rating = numRating
    order.feedback = String(feedback || '').trim().slice(0, 2000)
    order.feedbackAt = new Date()
    return res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: 'Server error' })
  }
})

// SSE stream for partner: new orders pushed in real time (no polling)
app.get('/api/orders/stream', ensureAuthQueryToken('partner'), async (req, res) => {
  let partnerEmail
  try {
    const user = await User.findById(req.user.uid).lean()
    partnerEmail = user?.email
    if (!partnerEmail) {
      res.status(403).json({ error: 'Partner email not found' })
      return
    }
  } catch (e) {
    return res.status(500).json({ error: 'Server error' })
  }
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()
  if (!partnerOrderStreams.has(partnerEmail)) partnerOrderStreams.set(partnerEmail, [])
  partnerOrderStreams.get(partnerEmail).push(res)
  res.on('close', () => {
    const conns = partnerOrderStreams.get(partnerEmail)
    if (conns) {
      const idx = conns.indexOf(res)
      if (idx !== -1) conns.splice(idx, 1)
      if (conns.length === 0) partnerOrderStreams.delete(partnerEmail)
    }
  })
  // Send initial ping so client knows connection is alive
  res.write(`event: connected\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`)
  if (typeof res.flush === 'function') res.flush()
})

connectMongo().then(() => {
  app.listen(PORT, () => {
    console.log(`API server listening on port ${PORT}`);
  });
});
