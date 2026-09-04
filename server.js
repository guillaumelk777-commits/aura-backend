const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const { Pool } = require('pg');
const { jwtVerify, createRemoteJWKSet } = require('jose');

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

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const jwks = SUPABASE_URL ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`)) : null;

const CATEGORIES = ['gaming','freestyle','dance','singing','music','sports','art','photography','cosplay','other'];
const MODES = ['video','audio','photo','local'];
const AGE_BRACKETS = ['13_17','18_plus'];
const REPORT_HIDE_THRESHOLD = 3;
const DAILY_GIFT_LIMIT_PER_RECIPIENT = 50;
const LOCAL_COST = 0;
const TOURNAMENT_COST = Number(process.env.TOURNAMENT_COST || 0);

function isValidId(v) { return typeof v === 'string' && v.trim().length > 0 && v.length <= 200; }
function isUuid(v) { return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v); }

async function verifyToken(token) {
  if (!token) throw new Error('Token ausente');
  if (SUPABASE_JWT_SECRET) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SUPABASE_JWT_SECRET), { algorithms: ['HS256'] });
    if (!payload.sub) throw new Error('Token inválido');
    return payload;
  }
  if (!jwks) throw new Error('SUPABASE_URL no configurada');
  const { payload } = await jwtVerify(token, jwks, { issuer: `${SUPABASE_URL}/auth/v1`, audience: 'authenticated' });
  if (!payload.sub) throw new Error('Token inválido');
  return payload;
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

async function getActiveUser(clientOrPool, userId) {
  const q = await clientOrPool.query(
    `SELECT id,username,aura_points,giftable_points,age_bracket,is_banned,is_admin,is_test_account,moderation_role,is_organizer,aura_test_completed,deleted_at
     FROM users WHERE id=$1 AND deleted_at IS NULL`,
    [userId]
  );
  return q.rows[0] || null;
}

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'5.1', status:'ok' }));

// ENDPOINT DE BATALLAS
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

// ENDPOINT DE RANKING
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
  if(req.params.id!==req.userId)return res.status(403).json({error:'No autorizado'});
  try{
    const u=await getActiveUser(pool,req.userId);
    if(!u)return res.status(404).json({error:'Usuario no encontrado'});
    const stats=await pool.query(`SELECT
      (SELECT COUNT(*) FROM battles WHERE status='completed' AND winner_id=$1)::int battles_won,
      (SELECT COUNT(*) FROM battles WHERE creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)::int battles_played`,[req.userId]);
    res.json({...u,...stats.rows[0],is_moderator:!!(u.is_admin||u.moderation_role==='admin'),is_organizer:!!u.is_organizer});
  }catch(e){res.status(500).json({error:'No se pudo cargar el perfil'});}
});

// RUTAS DE MODERACIÓN / ADMIN
async function requireAdmin(req,res,next){
  try{
    const q=await pool.query(`SELECT is_admin,moderation_role FROM users WHERE id=$1 AND deleted_at IS NULL`,[req.userId]);
    const u=q.rows[0];
    if(!u || !(u.is_admin===true || u.moderation_role==='admin')) return res.status(403).json({error:'Acceso denegado: permisos requeridos.'});
    next();
  }catch(e){res.status(500).json({error:'Error al verificar permisos.'});}
}

app.get('/api/admin/summary',auth,requireAdmin,async(req,res)=>{
  try{
    const [u,b,a]=await Promise.all([
      pool.query(`SELECT COUNT(*)::int count FROM users WHERE deleted_at IS NULL`),
      pool.query(`SELECT COUNT(*)::int count FROM battles WHERE status='active' AND hidden=false`),
      pool.query(`SELECT COALESCE(SUM(amount),0)::int total FROM admin_audit_logs WHERE action_type='GRANT_AURA' AND created_at>=date_trunc('day',NOW())`)
    ]);
    res.json({users:u.rows[0].count,active_battles:b.rows[0].count,aura_granted_today:a.rows[0].total});
  }catch(e){res.status(500).json({error:'Error al cargar el resumen.'});}
});

app.get('/api/admin/users/search',auth,requireAdmin,async(req,res)=>{
  const q=String(req.query.q||'').trim();
  if(q.length<2)return res.json([]);
  try{
    const r=await pool.query(`SELECT id,username,aura_points,giftable_points,is_banned,is_test_account,moderation_role,is_organizer,created_at
      FROM users WHERE deleted_at IS NULL AND (username ILIKE $1 OR id=$2) ORDER BY created_at DESC LIMIT 20`,[`%${q}%`,q]);
    res.json(r.rows);
  }catch(e){res.status(500).json({error:'Error en la búsqueda.'});}
});

app.post('/api/admin/grant-points',auth,requireAdmin,async(req,res)=>{
  const target=String(req.body?.target_user_id||'');
  const type=req.body?.type==='giftable'?'giftable':'aura';
  const points=Number(req.body?.points);
  const reason=typeof req.body?.reason==='string'?req.body.reason.trim().slice(0,200):'';
  if(!isValidId(target)||!Number.isInteger(points)||points<1||points>1000)return res.status(400).json({error:'Cantidad inválida (1-1000).'});
  if(target===req.userId)return res.status(400).json({error:'No podés otorgarte puntos a vos mismo.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const field=type==='giftable'?'giftable_points':'aura_points';
    await client.query(`UPDATE users SET ${field}=${field}+$1 WHERE id=$2`,[points,target]);
    await client.query(`INSERT INTO admin_audit_logs(admin_id,target_user_id,action_type,amount,reason) VALUES($1,$2,$3,$4,$5)`,[req.userId,target,`GRANT_${type.toUpperCase()}`,points,reason||'Premio']);
    await client.query('COMMIT');res.json({message:'Puntos otorgados correctamente.'});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`AURA STAR API v5.1 en puerto ${PORT}`));
