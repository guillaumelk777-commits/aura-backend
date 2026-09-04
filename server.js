const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');

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
const REPORT_HIDE_THRESHOLD = 3;
const DAILY_GIFT_LIMIT_PER_RECIPIENT = 50;
const POINTS_PER_AD = 5;
const DAILY_AD_POINTS_CAP = 60;
const LOCAL_COST = 0;
const TOURNAMENT_COST = Number(process.env.TOURNAMENT_COST || 0);
const ARBITER_CLOSE_VOTES = 30;
const MIN_VOTES = 10;
const MIN_DIFF = 3;

const SHARE_REWARD_MILESTONES = parseMilestones(process.env.SHARE_REWARD_MILESTONES || '5:5,10:10,25:25');
const SHARE_BASE_URL = (process.env.SHARE_BASE_URL || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET || '';
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';

const PRODUCTS = {
  starter: { points: 50 },
  plus: { points: 120 },
  pro: { points: 300 },
  mega: { points: 700 }
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
function newToken() { return crypto.randomBytes(32).toString('base64url'); }

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
  if (!b.opponent_id || vc === vo || vc + vo < MIN_VOTES || Math.abs(vc - vo) < MIN_DIFF) return null;
  return vc > vo ? b.creator_id : b.opponent_id;
}

async function settleBattle(client, b, vc, vo, forcedWinner = null) {
  const winnerId = forcedWinner || winnerFor(b, vc, vo);
  if (!winnerId) return null;
  const loserId = winnerId === b.creator_id ? b.opponent_id : b.creator_id;
  await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1', [winnerId]);
  await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1', [loserId]);
  await client.query(
    `UPDATE battles SET votes_creator=$1,votes_opponent=$2,status='completed',winner_id=$3,closed_at=NOW() WHERE id=$4`,
    [vc, vo, winnerId, b.id]
  );
  return winnerId;
}

// ----------------------------------------------------
// RUTAS PRINCIPALES DE LA API
// ----------------------------------------------------

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'5.1', status:'ok' }));

// CREAR/ACTUALIZAR USUARIO
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
  } catch(e){ console.error(e); res.status(500).json({error:'No se pudo guardar el usuario'}); }
});

// RANKING PÚBLICO
app.get('/api/users/ranking', async (req,res) => {
  try {
    const q = await pool.query(`SELECT id,username,aura_points,
      (SELECT COUNT(*) FROM battles b WHERE b.status='completed' AND b.winner_id=u.id)::int AS battles_won
      FROM users u WHERE deleted_at IS NULL AND is_banned=false ORDER BY aura_points DESC,created_at ASC LIMIT 50`);
    res.json(q.rows);
  } catch(e){ res.status(500).json({error:'No se pudo cargar el ranking'}); }
});

// OBTENER MI PERFIL
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

// ELIMINAR MI CUENTA
app.delete('/api/users/:id', auth, async (req,res) => {
  if(req.params.id!==req.userId) return res.status(403).json({error:'No autorizado'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = await client.query(`UPDATE users SET username=('deleted_'||substr(id,1,8)),is_banned=true,deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [req.userId]);
    if(!q.rowCount) throw Error('Usuario no encontrado');
    await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE status='active' AND (creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)`, [req.userId]);
    await client.query('COMMIT');
    res.json({message:'Cuenta eliminada'});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error:e.message});
  } finally { client.release(); }
});

// FEED DE BATALLAS
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

// CREAR BATALLA
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

// TEST DE AURA INICIAL
app.post('/api/users/aura-test', auth, rateLimit({ windowMs: 60000, max: 5 }), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await getActiveUser(client, req.userId, true);
    if (!u) throw Error('Usuario no encontrado.');
    if (u.aura_test_completed) throw Error('Ya realizaste tu test de Aura inicial.');

    const min = Number(req.body?.score_min) || 20;
    const max = Number(req.body?.score_max) || 100;
    const randomAura = Math.floor(Math.random() * (max - min + 1)) + min;

    await client.query(
      `UPDATE users SET aura_points = aura_points + $1, aura_test_completed = true WHERE id = $2`,
      [randomAura, req.userId]
    );

    await client.query(
      `INSERT INTO aura_tests(user_id,answers,camera_used,credited_aura)
       VALUES($1,$2,$3,$4) ON CONFLICT(user_id) DO NOTHING`,
      [req.userId, JSON.stringify(req.body?.answers || []), Boolean(req.body?.camera_used), randomAura]
    );

    await client.query('COMMIT');
    res.json({ credited_aura: randomAura, total_aura: u.aura_points + randomAura });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

// ----------------------------------------------------
// RUTAS DE MODERACIÓN / ADMIN
// ----------------------------------------------------

async function requireAdmin(req,res,next){
  try{
    const q = await pool.query(`SELECT is_admin,moderation_role FROM users WHERE id=$1 AND deleted_at IS NULL`,[req.userId]);
    const u = q.rows[0];
    if(!u || !(u.is_admin===true || u.moderation_role==='admin')) return res.status(403).json({error:'Acceso denegado: permisos requeridos.'});
    next();
  }catch(e){ res.status(500).json({error:'Error al verificar permisos.'}); }
}

app.get('/api/admin/summary', auth, requireAdmin, async (req,res) => {
  try {
    const [u, b, a] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int count FROM users WHERE deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int count FROM battles WHERE status='active' AND hidden=false`),
      pool.query(`SELECT COALESCE(SUM(amount),0)::int total FROM admin_audit_logs WHERE action_type='GRANT_AURA' AND created_at>=date_trunc('day',NOW())`)
    ]);
    res.json({users: u.rows[0].count, active_battles: b.rows[0].count, aura_granted_today: a.rows[0].total});
  } catch(e) { res.status(500).json({error:'Error al cargar el resumen.'}); }
});

app.get('/api/admin/users/search', auth, requireAdmin, async (req,res) => {
  const q = String(req.query.q||'').trim();
  if(q.length < 2) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT id,username,aura_points,giftable_points,is_banned,is_test_account,moderation_role,is_organizer,created_at
       FROM users WHERE deleted_at IS NULL AND (username ILIKE $1 OR id=$2) ORDER BY created_at DESC LIMIT 20`,
      [`%${q}%`, q]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:'Error en la búsqueda.'}); }
});

app.post('/api/admin/grant-points', auth, requireAdmin, async (req,res) => {
  const target = String(req.body?.target_user_id||'');
  const type = req.body?.type==='giftable' ? 'giftable' : 'aura';
  const points = Number(req.body?.points);
  const reason = typeof req.body?.reason==='string' ? req.body.reason.trim().slice(0,200) : '';
  if(!isValidId(target) || !Number.isInteger(points) || points < 1 || points > 1000) return res.status(400).json({error:'Cantidad inválida (1-1000).'});
  if(target === req.userId) return res.status(400).json({error:'No podés otorgarte puntos a vos mismo.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const field = type==='giftable' ? 'giftable_points' : 'aura_points';
    await client.query(`UPDATE users SET ${field}=${field}+$1 WHERE id=$2`, [points, target]);
    await client.query(`INSERT INTO admin_audit_logs(admin_id,target_user_id,action_type,amount,reason) VALUES($1,$2,$3,$4,$5)`, [req.userId, target, `GRANT_${type.toUpperCase()}`, points, reason||'Premio']);
    await client.query('COMMIT');
    res.json({message:'Puntos otorgados correctamente.'});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error: e.message});
  } finally { client.release(); }
});

app.post('/api/admin/set-organizer', auth, requireAdmin, async (req,res) => {
  const target = String(req.body?.target_user_id||'');
  const enabled = req.body?.enabled !== false;
  if(!isValidId(target) || target===req.userId) return res.status(400).json({error:'Usuario inválido.'});
  try {
    const r = await pool.query(`UPDATE users SET is_organizer=$1 WHERE id=$2 AND deleted_at IS NULL RETURNING id,username,is_organizer`, [enabled, target]);
    if(!r.rowCount) return res.status(404).json({error:'Usuario no encontrado.'});
    await pool.query(`INSERT INTO admin_audit_logs(admin_id,target_user_id,action_type,reason) VALUES($1,$2,$3,$4)`, [req.userId, target, enabled?'SET_ORGANIZER':'REMOVE_ORGANIZER', enabled?'Designado organizador':'Quitado organizador']);
    res.json({message: enabled ? 'Usuario designado como organizador.' : 'Rol retirado.'});
  } catch(e) { res.status(400).json({error:'Error al cambiar rol.'}); }
});

app.post('/api/admin/suspend-user', auth, requireAdmin, async (req,res) => {
  const target = String(req.body?.target_user_id||'');
  const reason = typeof req.body?.reason==='string' ? req.body.reason.trim().slice(0,200) : 'Moderación';
  if(!isValidId(target) || target===req.userId) return res.status(400).json({error:'No podés suspender esta cuenta.'});
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query(`UPDATE users SET is_banned=true WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [target]);
    if(!r.rowCount) throw Error('Usuario no encontrado.');
    await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE status='active' AND (creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)`, [target]);
    await client.query(`INSERT INTO admin_audit_logs(admin_id,target_user_id,action_type,reason) VALUES($1,$2,'SUSPEND_USER',$3)`, [req.userId, target, reason]);
    await client.query('COMMIT');
    res.json({message:'Usuario suspendido.'});
  } catch(e) {
    await client.query('ROLLBACK');
    res.status(400).json({error: e.message});
  } finally { client.release(); }
});

app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:'Error de servidor'}); });
app.use((req,res) => res.status(404).json({error:'Ruta no encontrada'}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURA STAR API v5.1 en puerto ${PORT}`));
