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
const ARBITER_CLOSE_VOTES = 30;
const MIN_VOTES = 10;
const MIN_DIFF = 3;

const SHARE_REWARD_MILESTONES = parseMilestones(process.env.SHARE_REWARD_MILESTONES || '5:5,10:10,25:25');
const SHARE_BASE_URL = (process.env.SHARE_BASE_URL || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET || 'aura_share_secret_default_key';

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

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'5.4', status:'ok' }));

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

// OBTENER DETALLE DE BATALLA POR ID
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

// UNIRSE A BATALLA MULTIMEDIA
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

// VOTAR EN BATALLA (CON VALIDACIÓN DE OPONENTE)
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
    
    // REGLA DE JUEGO LIMPIO: Si la batalla no tiene oponente o no subió contenido, no se permite votar
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

// BÚSQUEDA DE BATALLAS LOCALES
app.get('/api/battles/local/search', auth, async (req,res) => {
  const q = typeof req.query.q==='string' ? req.query.q.trim().slice(0,80) : '';
  if(q.length < 2) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT b.id, b.title, b.votes_creator, b.votes_opponent, b.local_closes_at,
              ua.username local_a_name, ub.username local_b_name FROM battles b
       LEFT JOIN users ua ON ua.id=b.local_participant_a 
       LEFT JOIN users ub ON ub.id=b.local_participant_b
       WHERE b.mode='local' AND b.status='active' AND b.hidden=false AND b.title ILIKE $1 
       ORDER BY b.created_at DESC LIMIT 30`,
      [`%${q}%`]
    );
    res.json(r.rows);
  } catch(e) { res.status(500).json({error:'Error en la búsqueda de batallas.'}); }
});

// SISTEMA DE REFERIDOS Y COMPARTIR
app.get('/api/share', auth, async (req,res) => {
  try {
    const token = crypto.createHmac('sha256', SHARE_TOKEN_SECRET).update(`aura-share-v2:${req.userId}`).digest('base64url');
    const tokenHash = sha256(token);
    await pool.query('INSERT INTO share_invites(user_id,token_hash) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash', [req.userId, tokenHash]);
    const countQ = await pool.query('SELECT COUNT(*)::int count FROM share_referrals WHERE referrer_id=$1', [req.userId]);
    const awardedQ = await pool.query('SELECT COALESCE(SUM(aura_points),0)::int total FROM share_rewards WHERE user_id=$1', [req.userId]);
    
    const count = countQ.rows[0].count;
    const totalAwarded = awardedQ.rows[0].total;
    const next = SHARE_REWARD_MILESTONES.find(x => x.users > count) || null;
    
    res.json({
      share_url: `${SHARE_BASE_URL || '/'}/?ref=${encodeURIComponent(token)}`,
      verified_users: count,
      total_aura_awarded: totalAwarded,
      next_milestone: next,
      milestones: SHARE_REWARD_MILESTONES
    });
  } catch(e) {
    res.status(500).json({error: 'No se pudo preparar el enlace de compartir'});
  }
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

// ELIMINAR BATALLA (ADMIN)
app.delete('/api/admin/battles/:id', auth, requireAdmin, async (req, res) => {
  const battleId = req.params.id;
  if (!isUuid(battleId)) return res.status(400).json({ error: 'ID de batalla inválido.' });
  
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM votes WHERE battle_id = $1', [battleId]);
    await client.query('DELETE FROM reports WHERE battle_id = $1', [battleId]);
    
    const r = await client.query('DELETE FROM battles WHERE id = $1 RETURNING id, title', [battleId]);
    if (!r.rowCount) throw new Error('La batalla no existe o ya fue eliminada.');
    
    await client.query(
      `INSERT INTO admin_audit_logs(admin_id, action_type, reason) VALUES($1, 'DELETE_BATTLE', $2)`,
      [req.userId, `Borrado de batalla ID: ${battleId}`]
    );
    
    await client.query('COMMIT');
    res.json({ message: '🗑️ Batalla eliminada correctamente.' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally {
    client.release();
  }
});

app.use((err,req,res,next) => { console.error(err); res.status(500).json({error:'Error de servidor'}); });
app.use((req,res) => res.status(404).json({error:'Ruta no encontrada'}));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURA STAR API v5.4 en puerto ${PORT}`));
