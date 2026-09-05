const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');

let MercadoPagoConfig, Preference, Payment, mpClient;
try {
  const mpModule = require('mercadopago');
  MercadoPagoConfig = mpModule.MercadoPagoConfig;
  Preference = mpModule.Preference;
  Payment = mpModule.Payment;
  if (process.env.MP_ACCESS_TOKEN) {
    mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });
  }
} catch (e) {
  console.warn('⚠️ SDK de Mercado Pago no encontrado.');
}

const app = express();
app.set('trust proxy', 1);

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin(origin, cb) {
    if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('Origen no permitido por CORS'));
  },
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on('error', err => console.error('Postgres pool error', err));

const SUPABASE_URL = String(process.env.SUPABASE_URL || 'https://saqhaofycdjlwdauzhtv.supabase.co').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_itAVUVk2JCkBjqKXSgQYrw_WsweKG1H';

const CATEGORIES = ['gaming','freestyle','dance','singing','music','sports','art','photography','cosplay','other'];
const MODES = ['video','audio','photo','local'];
const AGE_BRACKETS = ['13_17','18_plus'];
const ARBITER_CLOSE_VOTES = 30;
const MIN_VOTES = 10;
const MIN_DIFF = 3;

const SHARE_REWARD_MILESTONES = parseMilestones(process.env.SHARE_REWARD_MILESTONES || '5:5,10:10,25:25');
const SHARE_BASE_URL = (process.env.SHARE_BASE_URL || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET || 'aura_share_secret_default_key';

const PRICING = {
  starter: { points: 50, price: 2000, title: '50 Estrellas Aura — AURA STAR' },
  plus:    { points: 120, price: 4500, title: '120 Estrellas Aura — AURA STAR' },
  pro:     { points: 300, price: 10000, title: '300 Estrellas Aura — AURA STAR' },
  mega:    { points: 700, price: 22000, title: '700 Estrellas Aura — AURA STAR' }
};

function parseMilestones(raw) {
  const out = raw.split(',').map(x => x.trim()).map(x => {
    const [users, points] = x.split(':').map(Number);
    return Number.isInteger(users) && users > 0 && Number.isInteger(points) && points > 0 ? { users, points } : null;
  }).filter(Boolean).sort((a,b) => a.users - b.users);
  const seen = new Set();
  return out.filter(x => !seen.has(x.users) && seen.add(x.users));
}
function isValidId(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= 200; }
function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v); }
function sha256(v) { return crypto.createHash('sha256').update(v).digest('hex'); }

async function verifyToken(token) {
  if (!token) throw new Error('Token ausente');
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY }
  });
  const user = await r.json().catch(() => null);
  if (!r.ok || !user?.id) throw new Error('Token inválido');
  return { sub: user.id, user };
}

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  try {
    const payload = await verifyToken(h.slice(7));
    req.userId = String(payload.sub);
    req.auth = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

async function getActiveUser(clientOrPool, userId, forUpdate = false) {
  const q = await clientOrPool.query(
    `SELECT id,username,aura_points,giftable_points,age_bracket,is_banned,is_admin,is_test_account,moderation_role,is_organizer,aura_test_completed,deleted_at,created_at
     FROM users WHERE id=$1 AND deleted_at IS NULL${forUpdate ? ' FOR UPDATE' : ''}`,
    [userId]
  );
  return q.rows[0] || null;
}

async function activeBattleCount(client, userId) {
  const q = await client.query(
    `SELECT COUNT(*)::int AS count FROM battles WHERE status='active'
     AND (creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)`, [userId]
  );
  return q.rows[0].count;
}

function validateMediaUrl(v) { return typeof v === 'string' && /^https:\/\//i.test(v) && v.length <= 2048; }

function winnerFor(b, vc, vo) {
  const pa = b.mode === 'local' ? b.local_participant_a : b.creator_id;
  const pb = b.mode === 'local' ? b.local_participant_b : b.opponent_id;
  if (!pb || vc === vo || vc + vo < MIN_VOTES || Math.abs(vc - vo) < MIN_DIFF) return null;
  return vc > vo ? pa : pb;
}

async function settleBattle(client, b, vc, vo, forcedWinner = null) {
  const winnerId = forcedWinner || winnerFor(b, vc, vo);
  if (!winnerId) return null;
  const pa = b.mode === 'local' ? b.local_participant_a : b.creator_id;
  const pb = b.mode === 'local' ? b.local_participant_b : b.opponent_id;
  const loserId = winnerId === pa ? pb : pa;
  
  await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1', [winnerId]);
  if (loserId) await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1', [loserId]);
  await client.query(
    `UPDATE battles SET votes_creator=$1,votes_opponent=$2,status='completed',winner_id=$3,closed_at=NOW() WHERE id=$4`,
    [vc, vo, winnerId, b.id]
  );
  return winnerId;
}

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'5.7', status:'ok' }));

// MERCADO PAGO: Crear Checkout Pro
app.post('/api/payments/create-checkout', auth, async (req, res) => {
  if (!Preference || !process.env.MP_ACCESS_TOKEN) {
    return res.status(500).json({ error: 'Mercado Pago no está configurado en el servidor.' });
  }

  const packageId = req.body?.package_id;
  const pack = PRICING[packageId];
  if (!pack) return res.status(400).json({ error: 'Paquete inválido.' });

  try {
    const preference = new Preference(mpClient || new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN }));
    const result = await preference.create({
      body: {
        items: [{
          id: packageId,
          title: pack.title,
          unit_price: pack.price,
          quantity: 1,
          currency_id: 'ARS'
        }],
        metadata: {
          user_id: req.userId,
          package_id: packageId,
          points: pack.points
        },
        back_urls: {
          success: `${process.env.FRONTEND_ORIGIN || 'https://guillaumelk777-commits.github.io/aura-star-frontend/'}?payment=success`,
          failure: `${process.env.FRONTEND_ORIGIN || 'https://guillaumelk777-commits.github.io/aura-star-frontend/'}?payment=failure`
        },
        auto_return: 'approved'
      }
    });

    res.json({ init_point: result.init_point });
  } catch (e) {
    console.error('Error MP Preference:', e);
    res.status(500).json({ error: 'No se pudo generar el checkout.' });
  }
});

// MERCADO PAGO: Webhook
app.post('/api/payments/webhook', async (req, res) => {
  const { type, data } = req.body || {};
  if (type === 'payment' && data?.id && Payment && process.env.MP_ACCESS_TOKEN) {
    try {
      const payment = new Payment(mpClient || new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN }));
      const payInfo = await payment.get({ id: data.id });

      if (payInfo.status === 'approved') {
        const { user_id, points } = payInfo.metadata || {};
        if (user_id && points) {
          await pool.query(
            'UPDATE users SET giftable_points = giftable_points + $1 WHERE id = $2',
            [Number(points), user_id]
          );
        }
      }
    } catch (e) {
      console.error('Error procesando Webhook MP:', e);
    }
  }
  res.sendStatus(200);
});

// REGALAR ESTRELLAS AURA (DESCUENTA ESTRELLAS AL EMISOR -> SUMA AURA AL CREADOR)
app.post('/api/users/gift-stars', auth, rateLimit({ windowMs: 60000, max: 15 }), async (req, res) => {
  const { target_identifier, method, points } = req.body || {};
  const amount = Number(points);

  if (!Number.isInteger(amount) || amount < 1) {
    return res.status(400).json({ error: 'La cantidad de estrellas debe ser mayor a 0.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Emisor
    const sender = await getActiveUser(client, req.userId, true);
    if (!sender || sender.is_banned) throw Error('Tu cuenta no está disponible.');
    if (sender.giftable_points < amount) throw Error('No tenés suficientes Estrellas Aura.');

    // Destinatario
    let query = 'SELECT id, username FROM users WHERE deleted_at IS NULL AND is_banned = false AND ';
    let param = target_identifier?.trim();

    if (method === 'qr' || method === 'id') {
      query += 'id = $1';
    } else {
      param = param?.replace(/^@/, '');
      query += 'LOWER(username) = LOWER($1)';
    }

    const recipientQ = await client.query(query, [param]);
    const recipient = recipientQ.rows[0];

    if (!recipient) throw Error('No encontramos al usuario destinatario.');
    if (recipient.id === req.userId) throw Error('No podés regalarte estrellas a vos mismo.');

    // Descuento Estrellas Aura al emisor -> Acredita Puntos de Aura al destinatario
    await client.query('UPDATE users SET giftable_points = giftable_points - $1 WHERE id = $2', [amount, req.userId]);
    await client.query('UPDATE users SET aura_points = aura_points + $1 WHERE id = $2', [amount, recipient.id]);

    await client.query('COMMIT');
    res.json({ message: `¡Le enviaste +${amount} Aura a @${recipient.username}!`, remaining: sender.giftable_points - amount });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// USUARIOS, BATALLAS Y MODERACIÓN...
app.post('/api/users', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0,40) : null;
  const age = req.body?.age_bracket;
  if (age && !AGE_BRACKETS.includes(age)) return res.status(400).json({error:'age_bracket inválido'});
  if (!username) return res.status(400).json({error:'El nombre de usuario es obligatorio'});
  try {
    const q = await pool.query(
      `INSERT INTO users(id,username,age_bracket) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET username=COALESCE(NULLIF($2,''),users.username),age_bracket=COALESCE($3,users.age_bracket)
       RETURNING id,username,aura_points,giftable_points,age_bracket,is_banned,is_admin,is_test_account,moderation_role,is_organizer,aura_test_completed,created_at`,
      [req.userId,username,age || null]
    );
    res.json(q.rows[0]);
  } catch(e){ res.status(500).json({error:'No se pudo guardar el usuario'}); }
});

app.get('/api/users/ranking', async (req,res) => {
  try {
    const q = await pool.query(`SELECT id,username,aura_points,
      (SELECT COUNT(*) FROM battles b WHERE b.status='completed' AND b.winner_id=u.id)::int AS battles_won
      FROM users u WHERE deleted_at IS NULL AND is_banned=false ORDER BY aura_points DESC,created_at ASC LIMIT 50`);
    res.json(q.rows);
  } catch(e){ res.status(500).json({error:'No se pudo cargar el ranking'}); }
});

app.get('/api/users/:id', auth, async (req,res) => {
  if(req.params.id!==req.userId) return res.status(403).json({error:'No autorizado'});
  try {
    const u = await getActiveUser(pool, req.userId);
    if(!u) return res.status(404).json({error:'Usuario no encontrado'});
    const stats = await pool.query(`SELECT
      (SELECT COUNT(*) FROM battles WHERE status='completed' AND winner_id=$1)::int battles_won,
      (SELECT COUNT(*) FROM battles WHERE creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)::int battles_played`, [req.userId]);
    res.json({...u, ...stats.rows[0], is_moderator: !!(u.is_admin || u.moderation_role==='admin'), is_organizer: !!u.is_organizer});
  } catch(e) {
    res.status(500).json({error:'No se pudo cargar el perfil'});
  }
});

app.get('/api/battles', async (req,res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit,10)||30,1),50);
  try {
    const q = await pool.query(
      `SELECT b.id, b.creator_id, b.opponent_id, b.mode, b.category, b.title, 
              b.media_url_creator, b.media_url_opponent, b.votes_creator, b.votes_opponent, 
              b.local_participant_a, b.local_participant_b, b.local_neutral, b.local_closes_at, 
              b.status, b.hidden, b.created_at,
              ua.username AS creator_name, ub.username AS opponent_name,
              ula.username AS local_a_name, ulb.username AS local_b_name
       FROM battles b 
       LEFT JOIN users ua ON ua.id=b.creator_id 
       LEFT JOIN users ub ON ub.id=b.opponent_id
       LEFT JOIN users ula ON ula.id=b.local_participant_a 
       LEFT JOIN users ulb ON ulb.id=b.local_participant_b
       WHERE b.status='active' AND b.hidden=false 
       ORDER BY b.created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(q.rows);
  } catch(e) {
    res.status(500).json({ error: 'No se pudieron cargar las batallas' });
  }
});

app.get('/api/battles/:id', async (req, res) => {
  if(!isUuid(req.params.id)) return res.status(400).json({error:'ID de batalla inválido'});
  try {
    const q = await pool.query(
      `SELECT b.*, ua.username creator_name, ub.username opponent_name,
              ula.username local_a_name, ulb.username local_b_name
       FROM battles b 
       LEFT JOIN users ua ON ua.id=b.creator_id 
       LEFT JOIN users ub ON ub.id=b.opponent_id
       LEFT JOIN users ula ON ula.id=b.local_participant_a 
       LEFT JOIN users ulb ON ulb.id=b.local_participant_b 
       WHERE b.id=$1`, [req.params.id]
    );
    if(!q.rows[0]) return res.status(404).json({error:'Batalla no encontrada'});
    res.json(q.rows[0]);
  } catch(e) {
    res.status(500).json({error:'No se pudo cargar la batalla'});
  }
});

app.post('/api/battles', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const mode = String(req.body?.mode||'video');
  const category = String(req.body?.category||'');
  const title = typeof req.body?.title==='string' ? req.body.title.trim().slice(0,80) : '';
  if (!MODES.includes(mode) || !CATEGORIES.includes(category) || !title) return res.status(400).json({error:'Datos de batalla inválidos'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getActiveUser(client, req.userId, true);
    if (!user || user.is_banned) throw Error('Cuenta no disponible');
    if ((await activeBattleCount(client, req.userId)) >= 5) throw Error('Límite alcanzado: máximo 5 batallas activas simultáneas.');
    let row;
    if (mode === 'local') {
      const a = String(req.body?.local_participant_a||'').trim();
      const b = String(req.body?.local_participant_b||'').trim();
      const neutral = Boolean(req.body?.local_neutral);
      if (!isValidId(a) || !isValidId(b) || a === b) throw Error('Los dos competidores deben ser válidos y distintos.');
      const r = await client.query(
        `INSERT INTO battles(creator_id,mode,category,title,local_participant_a,local_participant_b,local_neutral,local_closes_at,status)
         VALUES($1,'local',$2,$3,$4,$5,$6,NOW()+INTERVAL '2 hours','active') RETURNING *`,
        [req.userId, category, title, a, b, neutral]
      );
      row = r.rows[0];
    } else {
      const url = req.body?.media_url_creator;
      if (!validateMediaUrl(url)) throw Error('La URL multimedia del creador es requerida.');
      const r = await client.query(
        `INSERT INTO battles(creator_id,mode,category,title,media_url_creator,status) 
         VALUES($1,$2,$3,$4,$5,'active') RETURNING *`,
        [req.userId, mode, category, title, url]
      );
      row = r.rows[0];
    }
    await client.query('COMMIT');
    res.status(201).json(row);
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error: e.message});
  } finally { client.release(); }
});

app.post('/api/battles/:id/join', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const url = req.body?.media_url_opponent || req.body?.media_url;
  if(!validateMediaUrl(url)) return res.status(400).json({error:'La participación es obligatoria.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await getActiveUser(client, req.userId, true);
    if (!user || user.is_banned) throw Error('Cuenta no disponible.');
    const q = await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE', [req.params.id]);
    const b = q.rows[0];
    if(!b || b.status!=='active') throw Error('La batalla no está activa.');
    if(b.creator_id === req.userId) throw Error('No podés unirte a tu propia batalla.');
    if(b.opponent_id) throw Error('La batalla ya tiene oponente.');
    
    const r = await client.query(`UPDATE battles SET opponent_id=$1, media_url_opponent=$2 WHERE id=$3 RETURNING *`, [req.userId, url, req.params.id]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error: e.message});
  } finally { client.release(); }
});

app.post('/api/battles/:id/vote', auth, rateLimit({windowMs:60000,max:30}), async (req,res) => {
  const target = req.body?.voted_user_id;
  if(!isValidId(target)) return res.status(400).json({error:'Participante inválido.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const voter = await getActiveUser(client, req.userId, true);
    if(!voter || voter.is_banned) throw Error('Cuenta suspendida.');
    
    const q = await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE', [req.params.id]);
    const b = q.rows[0];
    if(!b || b.status!=='active') throw Error('La batalla no está activa.');
    
    if (!b.opponent_id || (b.mode !== 'local' && !b.media_url_opponent)) {
      throw Error('La votación estará disponible cuando se una un oponente con su contenido.');
    }

    const pa = b.mode === 'local' ? b.local_participant_a : b.creator_id;
    const pb = b.mode === 'local' ? b.local_participant_b : b.opponent_id;
    
    if(req.userId === pa || req.userId === pb) throw Error('No podés votar en tu propia batalla.');
    if(target !== pa && target !== pb) throw Error('Participante inválido.');
    
    const prior = await client.query('SELECT 1 FROM votes WHERE battle_id=$1 AND voter_id=$2', [b.id, req.userId]);
    if(prior.rowCount) throw Error('Ya votaste en esta batalla.');
    
    await client.query('INSERT INTO votes(battle_id, voter_id, voted_user_id) VALUES($1,$2,$3)', [b.id, req.userId, target]);
    
    const vc = Number(b.votes_creator) + (target === pa ? 1 : 0);
    const vo = Number(b.votes_opponent) + (target === pb ? 1 : 0);
    
    const winner = await settleBattle(client, b, vc, vo);
    if(!winner) await client.query('UPDATE battles SET votes_creator=$1, votes_opponent=$2 WHERE id=$3', [vc, vo, b.id]);
    
    await client.query('COMMIT');
    res.json({message: 'Voto registrado correctamente', votes_creator: vc, votes_opponent: vo, total_votes: vc + vo, completed: Boolean(winner), winner_id: winner});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error: e.message});
  } finally { client.release(); }
});

app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:'Error de servidor'}); });
app.use((req,res) => res.status(404).json({error:'Ruta no encontrada'}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURA STAR API v5.7 en puerto ${PORT}`));
