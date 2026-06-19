const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const FIREBASE_API_KEY = 'AIzaSyD2V5E2i9LvMr6fw9uRYZQlOA1BYKNJhmc';

app.use(cors());
app.use(express.json());

// ─── Firebase token verification ──────────────────────────────────────────

async function verifyFirebaseToken(idToken) {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.users?.[0]) throw new Error('Invalid Firebase token');
  return data.users[0];
}

// ─── Auth middleware ───────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });

  const user = db.get().users[token];
  if (!user) return res.status(401).json({ error: 'User not found' });

  req.user = user;
  next();
}

// ─── Auth ─────────────────────────────────────────────────────────────────

app.post('/api/auth/firebase', async (req, res) => {
  try {
    const { idToken, email } = req.body;
    if (!idToken) return res.status(400).json({ error: 'idToken required' });

    const firebaseUser = await verifyFirebaseToken(idToken);
    const uid = firebaseUser.localId;
    const phone = firebaseUser.phoneNumber || null;
    const userEmail = email || firebaseUser.email || null;

    const d = db.get();
    if (!d.users[uid]) {
      d.users[uid] = {
        id: uid,
        phone,
        email: userEmail,
        username: userEmail
          ? userEmail.split('@')[0]
          : phone
          ? `user_${phone.slice(-4)}`
          : `user_${uid.slice(0, 6)}`,
        steps: 0,
        distance: 0,
        xp: 0,
        level: 1,
        created_at: new Date().toISOString(),
      };
    } else {
      if (phone && !d.users[uid].phone) d.users[uid].phone = phone;
      if (userEmail && !d.users[uid].email) d.users[uid].email = userEmail;
    }
    db.save();

    res.json({ token: uid, user: d.users[uid] });
  } catch (err) {
    console.error('Auth error:', err.message);
    res.status(401).json({ error: err.message });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => res.json(req.user));

// ─── Users ────────────────────────────────────────────────────────────────

app.get('/api/users/profile', authMiddleware, (req, res) => {
  const d = db.get();
  const now = new Date();
  const territoriesCount = Object.values(d.territories).filter(
    t => t.owner_id === req.user.id && new Date(t.expires_at) > now
  ).length;

  const clanId = d.clan_members[req.user.id];
  const clan = clanId ? d.clans[clanId] : null;

  res.json({ ...req.user, territoriesCount, clan: clan || null });
});

app.put('/api/users/profile', authMiddleware, (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'username required' });
  const d = db.get();
  d.users[req.user.id].username = username;
  db.save();
  res.json({ success: true });
});

app.post('/api/users/steps', authMiddleware, (req, res) => {
  const { steps = 0, distance = 0 } = req.body;
  const d = db.get();
  const u = d.users[req.user.id];
  u.steps += steps;
  u.distance += distance;
  const xpGained = Math.floor(steps / 100);
  u.xp += xpGained;
  u.level = Math.floor(u.xp / 500) + 1;
  db.save();
  res.json({ success: true, xpGained });
});

app.get('/api/users/leaderboard', (req, res) => {
  const users = Object.values(db.get().users)
    .sort((a, b) => b.xp - a.xp)
    .slice(0, 50)
    .map(({ id, username, steps, distance, xp, level }) => ({ id, username, steps, distance, xp, level }));
  res.json(users);
});

// ─── Territories ──────────────────────────────────────────────────────────

app.get('/api/territories', authMiddleware, (req, res) => {
  const now = new Date();
  const all = Object.values(db.get().territories)
    .filter(t => new Date(t.expires_at) > now)
    .map(t => ({ ...t, isOwn: t.owner_id === req.user.id }));
  res.json(all);
});

app.get('/api/territories/my', authMiddleware, (req, res) => {
  const now = new Date();
  const mine = Object.values(db.get().territories)
    .filter(t => t.owner_id === req.user.id && new Date(t.expires_at) > now)
    .map(t => ({ ...t, isOwn: true }));
  res.json(mine);
});

app.post('/api/territories/capture', authMiddleware, (req, res) => {
  const { polygon, name } = req.body;
  if (!polygon || polygon.length < 3) return res.status(400).json({ error: 'Invalid polygon' });

  const id = uuidv4();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const territory = {
    id,
    owner_id: req.user.id,
    polygon,
    name: name || 'Моя территория',
    captured_at: new Date().toISOString(),
    expires_at: expiresAt,
    shield_expires_at: null,
  };

  const d = db.get();
  d.territories[id] = territory;
  d.users[req.user.id].xp += 50;
  db.save();

  io.emit('territory_updated', { ...territory, isOwn: false });
  res.json({ success: true, territory });
});

app.post('/api/territories/confirm/:id', authMiddleware, (req, res) => {
  res.json({ success: true });
});

app.post('/api/territories/shield/:id', authMiddleware, (req, res) => {
  const { days } = req.body;
  const d = db.get();
  const t = d.territories[req.params.id];
  if (!t || t.owner_id !== req.user.id) return res.status(404).json({ error: 'Not found' });

  const shieldExpires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  t.shield_expires_at = shieldExpires;
  t.expires_at = shieldExpires;
  db.save();
  res.json({ success: true });
});

// ─── Clans ────────────────────────────────────────────────────────────────

app.get('/api/clans/my', authMiddleware, (req, res) => {
  const d = db.get();
  const clanId = d.clan_members[req.user.id];
  if (!clanId) return res.json(null);

  const clan = d.clans[clanId];
  const members = Object.entries(d.clan_members)
    .filter(([, cid]) => cid === clanId)
    .map(([uid]) => {
      const u = d.users[uid];
      return u ? { id: u.id, username: u.username, xp: u.xp, steps: u.steps } : null;
    })
    .filter(Boolean);

  res.json({ ...clan, members, isOwner: clan.owner_id === req.user.id });
});

app.post('/api/clans/create', authMiddleware, (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const d = db.get();
  if (d.clan_members[req.user.id]) return res.status(400).json({ error: 'Вы уже состоите в клане' });

  const nameExists = Object.values(d.clans).some(c => c.name === name);
  if (nameExists) return res.status(400).json({ error: 'Клан с таким названием уже существует' });

  const id = uuidv4();
  d.clans[id] = { id, name, owner_id: req.user.id, created_at: new Date().toISOString() };
  d.clan_members[req.user.id] = id;
  db.save();

  res.json({ success: true, clan: d.clans[id] });
});

app.post('/api/clans/invite', authMiddleware, (req, res) => {
  const { phone } = req.body;
  const d = db.get();
  const invitee = Object.values(d.users).find(u => u.phone === phone);
  if (!invitee) return res.status(404).json({ error: 'Пользователь не найден' });

  const clanId = d.clan_members[req.user.id];
  if (!clanId) return res.status(400).json({ error: 'Вы не в клане' });

  if (d.clan_members[invitee.id]) return res.status(400).json({ error: 'Пользователь уже в клане' });

  d.clan_members[invitee.id] = clanId;
  db.save();
  res.json({ success: true });
});

app.post('/api/clans/leave', authMiddleware, (req, res) => {
  const d = db.get();
  const clanId = d.clan_members[req.user.id];
  if (!clanId) return res.status(400).json({ error: 'Вы не в клане' });

  const clan = d.clans[clanId];
  delete d.clan_members[req.user.id];

  if (clan.owner_id === req.user.id) {
    Object.keys(d.clan_members).forEach(uid => {
      if (d.clan_members[uid] === clanId) delete d.clan_members[uid];
    });
    delete d.clans[clanId];
  }
  db.save();
  res.json({ success: true });
});

// ─── Purchases ────────────────────────────────────────────────────────────

app.post('/api/purchases/verify', authMiddleware, (req, res) => {
  const { productId, purchaseToken } = req.body;
  if (!productId || !purchaseToken) return res.status(400).json({ error: 'productId and purchaseToken required' });

  const days = productId.includes('7day') ? 7 : productId.includes('3day') ? 3 : 1;
  const d = db.get();
  d.purchases.push({ id: uuidv4(), user_id: req.user.id, product_id: productId, verified_at: new Date().toISOString() });

  const now = new Date();
  const territory = Object.values(d.territories)
    .filter(t => t.owner_id === req.user.id && new Date(t.expires_at) > now)
    .sort((a, b) => new Date(b.captured_at) - new Date(a.captured_at))[0];

  if (territory) {
    const shieldExpires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    territory.shield_expires_at = shieldExpires;
    territory.expires_at = shieldExpires;
  }
  db.save();
  res.json({ success: true, days });
});

// ─── Socket.io ────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);
  socket.on('territory_captured', data => socket.broadcast.emit('territory_updated', data));
  socket.on('location_update', data => socket.broadcast.emit('player_moved', data));
  socket.on('disconnect', () => console.log('❌ Disconnected:', socket.id));
});

// ─── Health ───────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

server.listen(PORT, () => {
  console.log(`\n🚀 GeoFitBattle Server → http://localhost:${PORT}`);
  console.log(`✅ Health: http://localhost:${PORT}/api/health\n`);
});
