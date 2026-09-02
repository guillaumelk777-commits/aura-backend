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

const SUPABASE_URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || '';

const CATEGORIES = ['gaming','freestyle','dance','singing','music','sports','art','photography','cosplay','other'];
const MODES = ['video','audio','photo','local'];
const AGE_BRACKETS = ['13_17','18_plus'];
const REPORT_HIDE_THRESHOLD = 3;
const DAILY_GIFT_LIMIT_PER_RECIPIENT = 50;
const POINTS_PER_AD = 5;
const DAILY_AD_POINTS_CAP = 60;
const LOCAL_COST = 20;
const ARBITER_CLOSE_VOTES = 30;
const MIN_VOTES = 10;
const MIN_DIFF = 3;

const SHARE_REWARD_MILESTONES = parseMilestones(process.env.SHARE_REWARD_MILESTONES || '5:10,10:20,25:70');
const SHARE_BASE_URL = (process.env.SHARE_BASE_URL || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET || 'aura_star_secret_key_default';
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

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Autenticación requerida' });
  const token = h.slice(7);
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': SUPABASE_ANON_KEY
      }
    });
    if (!r.ok) throw new Error('Sesión inválida');
    const user = await r.json();
    if (!user || !user.id) throw new Error('Usuario no válido');
    req.userId = user.id;
    req.authUser = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

async function getActiveUser(clientOrPool, userId, forUpdate = false) {
  const q = await clientOrPool.query(
    `SELECT id,username,aura_points,giftable_points,age_bracket,is_banned,deleted_at,created_at,aura_test_completed
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

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'2.3', status:'ok' }));

app.post('/api/users', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0,40) : null;
  const age = req.body?.age_bracket;
  if (age && !AGE_BRACKETS.includes(age)) return res.status(400).json({error:'age_bracket inválido'});
  if (!username) return res.status(400).json({error:'El nombre de usuario es obligatorio'});
  try {
    const q = await pool.query(
      `INSERT INTO users(id,username,age_bracket) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET username=COALESCE(NULLIF($2,''),users.username),age_bracket=COALESCE($3,users.age_bracket)
       RETURNING id,username,aura_points,giftable_points,age_bracket,is_banned,created_at,aura_test_completed`,
      [req.userId,username,age || null]
    );
    res.json(q.rows[0]);
  } catch(e){ console.error(e); res.status(500).json({error:'No se pudo guardar el usuario'}); }
});

app.post('/api/users/aura-test', auth, rateLimit({ windowMs: 60000, max: 5 }), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await getActiveUser(client, req.userId, true);
    if (!u) throw Error('Usuario no encontrado.');
    if (u.aura_test_completed) throw Error('Ya realizaste tu test de Aura inicial.');

    const randomAura = Math.floor(Math.random() * (100 - 20 + 1)) + 20;

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

app.get('/api/users/ranking', async (req,res) => {
  try {
    const q=await pool.query(`SELECT id,username,aura_points,
      (SELECT COUNT(*) FROM battles b WHERE b.status='completed' AND b.winner_id=u.id)::int AS battles_won
      FROM users u WHERE deleted_at IS NULL AND is_banned=false ORDER BY aura_points DESC,created_at ASC LIMIT 50`);
    res.json(q.rows);
  } catch(e){res.status(500).json({error:'No se pudo cargar el ranking'});}
});

app.get('/api/users/:id', auth, async (req,res) => {
  if(req.params.id!==req.userId)return res.status(403).json({error:'No autorizado'});
  try{
    const u=await getActiveUser(pool,req.userId);
    if(!u)return res.status(404).json({error:'Usuario no encontrado'});
    const stats=await pool.query(`SELECT
      (SELECT COUNT(*) FROM battles WHERE status='completed' AND winner_id=$1)::int battles_won,
      (SELECT COUNT(*) FROM battles WHERE creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)::int battles_played`,[req.userId]);
    res.json({...u,...stats.rows[0]});
  }catch(e){res.status(500).json({error:'No se pudo cargar el perfil'});}
});

app.delete('/api/users/:id', auth, async (req,res) => {
  if(req.params.id!==req.userId)return res.status(403).json({error:'No autorizado'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query(`UPDATE users SET username=NULL,is_banned=true,deleted_at=NOW() WHERE id=$1 AND deleted_at IS NULL RETURNING id`,[req.userId]);
    if(!q.rowCount)throw Error('Usuario no encontrado');
    await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE status='active' AND (creator_id=$1 OR opponent_id=$1 OR local_participant_a=$1 OR local_participant_b=$1)`,[req.userId]);
    await client.query('COMMIT');res.json({message:'Cuenta eliminada'});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

// Listado global público: Todos pueden ver las batallas
app.get('/api/battles', async (req,res) => {
  const limit=Math.min(Math.max(parseInt(req.query.limit,10)||30,1),50);
  try{
    const q=await pool.query(`SELECT b.*,ua.username creator_name,ub.username opponent_name,
      ula.username local_a_name,ulb.username local_b_name
      FROM battles b LEFT JOIN users ua ON ua.id=b.creator_id LEFT JOIN users ub ON ub.id=b.opponent_id
      LEFT JOIN users ula ON ula.id=b.local_participant_a LEFT JOIN users ulb ON ulb.id=b.local_participant_b
      WHERE b.status='active' AND b.hidden=false ORDER BY b.created_at DESC LIMIT $1`,[limit]);
    res.json(q.rows);
  }catch(e){res.status(500).json({error:'No se pudieron cargar las batallas'});}
});

app.get('/api/battles/:id', async (req,res) => {
  if(!isUuid(req.params.id))return res.status(400).json({error:'ID de batalla inválido'});
  try{
    const q=await pool.query(`SELECT b.*,ua.username creator_name,ub.username opponent_name,
      ula.username local_a_name,ulb.username local_b_name
      FROM battles b LEFT JOIN users ua ON ua.id=b.creator_id LEFT JOIN users ub ON ub.id=b.opponent_id
      LEFT JOIN users ula ON ula.id=b.local_participant_a LEFT JOIN users ulb ON ulb.id=b.local_participant_b WHERE b.id=$1`,[req.params.id]);
    if(!q.rows[0])return res.status(404).json({error:'Batalla no encontrada'});res.json(q.rows[0]);
  }catch(e){res.status(500).json({error:'No se pudo cargar la batalla'});}
});

app.post('/api/battles', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const mode=String(req.body?.mode||'video');
  const category=String(req.body?.category||'');
  const title=typeof req.body?.title==='string'?req.body.title.trim().slice(0,80):'';
  const theme=typeof req.body?.theme==='string'?req.body.theme.trim().slice(0,120):null;
  if(!MODES.includes(mode)||!CATEGORIES.includes(category)||!title)return res.status(400).json({error:'Datos de batalla inválidos'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const user=await getActiveUser(client,req.userId,true);if(!user)throw Error('Usuario no registrado');if(user.is_banned)throw Error('Cuenta suspendida');
    if((await activeBattleCount(client,req.userId))>=5)throw Error('Límite alcanzado: máximo 5 batallas activas simultáneas.');
    let row;
    if(mode==='local'){
      const a=String(req.body?.local_participant_a||'').trim(),b=String(req.body?.local_participant_b||'').trim();
      const neutral=Boolean(req.body?.local_neutral);
      if(!isValidId(a)||!isValidId(b)||a===b)throw Error('Los dos competidores deben ser válidos y distintos.');
      const pa=await getActiveUser(client,a);const pb=await getActiveUser(client,b);if(!pa||!pb)throw Error('Uno de los competidores no existe o no está disponible.');
      
      // BLOQUEO DE COMPETENCIA ENTRE DISTINTAS EDADES EN LOCAL
      if(pa.age_bracket && pb.age_bracket && pa.age_bracket !== pb.age_bracket){
        throw Error('No se pueden enfrentar competidores de distintas franjas etarias.');
      }

      const cost=LOCAL_COST;
      if(user.giftable_points<cost)throw Error(`Necesitás ${cost} puntos regalables para crear una batalla local.`);
      await client.query('UPDATE users SET giftable_points=giftable_points-$1 WHERE id=$2',[cost,req.userId]);
      const r=await client.query(`INSERT INTO battles(creator_id,mode,category,title,theme,local_participant_a,local_participant_b,local_neutral,local_closes_at,status)
        VALUES($1,'local',$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '2 hours','active') RETURNING *`,[req.userId,category,title,theme,a,b,neutral]);row=r.rows[0];
    }else{
      const url=req.body?.media_url_creator;if(!validateMediaUrl(url))throw Error('La participación del creador es obligatoria y debe ser una URL HTTPS válida.');
      const r=await client.query(`INSERT INTO battles(creator_id,mode,category,title,theme,media_url_creator,status) VALUES($1,$2,$3,$4,$5,$6,'active') RETURNING *`,[req.userId,mode,category,title,theme,url]);row=r.rows[0];
    }
    await client.query('COMMIT');res.status(201).json(row);
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

// BLOQUEO DE COMPETENCIA: Unirse a una batalla solo se permite si coinciden en age_bracket
app.post('/api/battles/:id/join', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const url=req.body?.media_url_opponent||req.body?.media_url;if(!validateMediaUrl(url))return res.status(400).json({error:'La participación del oponente es obligatoria'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const user=await getActiveUser(client,req.userId,true);if(!user)throw Error('Usuario no registrado');if(user.is_banned)throw Error('Cuenta suspendida');
    if((await activeBattleCount(client,req.userId))>=5)throw Error('Límite alcanzado: máximo 5 batallas activas simultáneas.');
    const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=q.rows[0];if(!b||b.status!=='active')throw Error('La batalla no está activa');
    if(b.mode==='local')throw Error('Las batallas locales no se aceptan por este enlace');if(b.creator_id===req.userId)throw Error('No podés unirte a tu propia batalla');if(b.opponent_id)throw Error('La batalla ya tiene oponente');
    const creator=await getActiveUser(client,b.creator_id);if(!creator)throw Error('Creador no disponible');
    
    // VALIDACIÓN ESTRICTA: Solo pueden competir si son de la misma franja etaria
    if(creator.age_bracket && user.age_bracket && creator.age_bracket !== user.age_bracket){
      throw Error('No podés competir contra usuarios de otra franja etaria.');
    }
    
    const r=await client.query(`UPDATE battles SET opponent_id=$1,media_url_opponent=$2 WHERE id=$3 AND opponent_id IS NULL RETURNING *`,[req.userId,url,req.params.id]);if(!r.rowCount)throw Error('Otro usuario aceptó la batalla primero');
    await client.query('COMMIT');res.json(r.rows[0]);
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

// VOTACIÓN ABIERTA: Cualquier usuario activo puede votar independientemente de su edad
app.post('/api/battles/:id/vote', auth, rateLimit({windowMs:60000,max:30}), async (req,res) => {
  const target=req.body?.voted_user_id;if(!isValidId(target))return res.status(400).json({error:'Participante inválido'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const voter=await getActiveUser(client,req.userId,true);if(!voter)throw Error('Usuario no registrado');if(voter.is_banned)throw Error('Cuenta suspendida');
    const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=q.rows[0];if(!b||b.status!=='active')throw Error('La batalla no está activa');if(b.hidden)throw Error('Esta batalla está en revisión');
    if(!b.opponent_id||!b.media_url_creator||!b.media_url_opponent)throw Error('La votación comienza cuando ambos participantes presentaron su participación.');
    if(req.userId===b.creator_id||req.userId===b.opponent_id)throw Error('No podés votar en tu propia batalla');
    if(target!==b.creator_id&&target!==b.opponent_id)throw Error('Participante inválido');
    const prior=await client.query('SELECT 1 FROM votes WHERE battle_id=$1 AND voter_id=$2',[b.id,req.userId]);if(prior.rowCount)throw Error('Ya votaste en esta batalla');
    await client.query('INSERT INTO votes(battle_id,voter_id,voted_user_id) VALUES($1,$2,$3)',[b.id,req.userId,target]);
    const vc=Number(b.votes_creator)+(target===b.creator_id?1:0),vo=Number(b.votes_opponent)+(target===b.opponent_id?1:0);
    const winner=await settleBattle(client,b,vc,vo);
    if(!winner)await client.query('UPDATE battles SET votes_creator=$1,votes_opponent=$2 WHERE id=$3',[vc,vo,b.id]);
    await client.query('COMMIT');res.json({message:'Voto registrado correctamente',votes_creator:vc,votes_opponent:vo,total_votes:vc+vo,completed:Boolean(winner),winner_id:winner});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/battles/:id/arbiter-close', auth, rateLimit({windowMs:60000,max:10}), async (req,res) => {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const bq=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=bq.rows[0];if(!b)throw Error('Batalla no encontrada');
    if(b.mode!=='local'||!b.local_neutral||b.creator_id!==req.userId)throw Error('Solo el árbitro neutral de esta batalla puede cerrarla.');
    if(b.status!=='active')throw Error('La batalla no está activa');const total=Number(b.votes_creator)+Number(b.votes_opponent);const diff=Math.abs(Number(b.votes_creator)-Number(b.votes_opponent));
    if(total<ARBITER_CLOSE_VOTES||diff<MIN_DIFF)throw Error(`El árbitro puede cerrar desde ${ARBITER_CLOSE_VOTES} votos y diferencia ${MIN_DIFF}.`);
    const winner=b.votes_creator>b.votes_opponent?b.local_participant_a:b.local_participant_b;const loser=winner===b.local_participant_a?b.local_participant_b:b.local_participant_a;
    await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1',[winner]);await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1',[loser]);
    await client.query(`UPDATE battles SET status='completed',winner_id=$1,closed_at=NOW() WHERE id=$2`,[winner,b.id]);await client.query('COMMIT');res.json({completed:true,winner_id:winner});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/battles/:id/report', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const reason=typeof req.body?.reason==='string'?req.body.reason.trim().slice(0,300):'';if(!reason)return res.status(400).json({error:'El motivo es obligatorio'});
  const client=await pool.connect();try{
    await client.query('BEGIN');const u=await getActiveUser(client,req.userId,true);if(!u)throw Error('Usuario no registrado');if(u.is_banned)throw Error('Cuenta suspendida');
    const b=await client.query('SELECT id,report_count,hidden FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);if(!b.rows[0])throw Error('Batalla no encontrada');
    const ins=await client.query(`INSERT INTO reports(battle_id,reporter_id,reason) VALUES($1,$2,$3) ON CONFLICT(battle_id,reporter_id) DO NOTHING RETURNING id`,[req.params.id,req.userId,reason]);
    if(!ins.rowCount){await client.query('COMMIT');return res.json({message:'Ya habías reportado esta batalla',hidden:b.rows[0].hidden});}
    const count=Number(b.rows[0].report_count)+1,hidden=count>=REPORT_HIDE_THRESHOLD;await client.query('UPDATE battles SET report_count=$1,hidden=$2 WHERE id=$3',[count,hidden,req.params.id]);await client.query('COMMIT');res.json({message:hidden?'La batalla fue ocultada y enviada a revisión':'Reporte enviado. Gracias por ayudar a mantener AURA STAR segura.',hidden});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.get('/api/battles/local/search', auth, async (req,res) => {
  const q=typeof req.query.q==='string'?req.query.q.trim().slice(0,80):'';if(q.length<2)return res.json([]);
  try{const r=await pool.query(`SELECT b.id,b.title,b.theme,b.votes_creator,b.votes_opponent,b.local_closes_at,
    ua.username local_a_name,ub.username local_b_name FROM battles b
    LEFT JOIN users ua ON ua.id=b.local_participant_a LEFT JOIN users ub ON ub.id=b.local_participant_b
    WHERE b.mode='local' AND b.status='active' AND b.hidden=false AND b.title ILIKE $1 ORDER BY b.created_at DESC LIMIT 30`,[`%${q}%`]);res.json(r.rows);
  }catch(e){res.status(500).json({error:'No se pudo buscar batallas locales'});}
});

app.get('/api/share', auth, async (req,res) => {
  try{
    const token=crypto.createHmac('sha256',SHARE_TOKEN_SECRET).update(`aura-share-v2:${req.userId}`).digest('base64url');
    const tokenHash=sha256(token);
    await pool.query('INSERT INTO share_invites(user_id,token_hash) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET token_hash=EXCLUDED.token_hash',[req.userId,tokenHash]);
    const countQ=await pool.query('SELECT COUNT(*)::int count FROM share_referrals WHERE referrer_id=$1',[req.userId]);
    const awardedQ=await pool.query('SELECT COALESCE(SUM(aura_points),0)::int total FROM share_rewards WHERE user_id=$1',[req.userId]);
    const count=countQ.rows[0].count,totalAwarded=awardedQ.rows[0].total;const next=SHARE_REWARD_MILESTONES.find(x=>x.users>count)||null;
    res.json({share_url:`${SHARE_BASE_URL||'/'}/?ref=${encodeURIComponent(token)}`,verified_users:count,total_aura_awarded:totalAwarded,next_milestone:next,milestones:SHARE_REWARD_MILESTONES});
  }catch(e){res.status(500).json({error:'No se pudo preparar el enlace de compartir'});}
});

app.post('/api/share/claim', auth, rateLimit({windowMs:60000,max:10}), async (req,res) => {
  const token=typeof req.body?.token==='string'?req.body.token.trim():'';if(!/^[A-Za-z0-9_-]{20,100}$/.test(token))return res.status(400).json({error:'Enlace de invitación inválido'});
  const tokenHash=sha256(token),client=await pool.connect();
  try{
    await client.query('BEGIN');const inv=await client.query('SELECT user_id FROM share_invites WHERE token_hash=$1',[tokenHash]);if(!inv.rows[0])throw Error('El enlace de invitación no existe o expiró');
    const referrer=inv.rows[0].user_id;if(referrer===req.userId)throw Error('No podés obtener Aura invitándote a vos mismo.');
    const u=await getActiveUser(client,req.userId,true);if(!u)throw Error('Primero completá tu perfil.');if(u.is_banned)throw Error('Cuenta suspendida');
    const existing=await client.query('SELECT id FROM share_referrals WHERE referred_user_id=$1',[req.userId]);if(existing.rowCount){await client.query('COMMIT');return res.json({message:'Esta cuenta ya fue registrada mediante una invitación.',credited:0});}
    await client.query('INSERT INTO share_referrals(referrer_id,referred_user_id,token_hash) VALUES($1,$2,$3)',[referrer,req.userId,tokenHash]);
    const count=Number((await client.query('SELECT COUNT(*)::int count FROM share_referrals WHERE referrer_id=$1',[referrer])).rows[0].count);
    let credited=0;
    for(const m of SHARE_REWARD_MILESTONES){if(count>=m.users){const ins=await client.query(`INSERT INTO share_rewards(user_id,milestone_users,aura_points) VALUES($1,$2,$3) ON CONFLICT(user_id,milestone_users) DO NOTHING RETURNING id`,[referrer,m.users,m.points]);if(ins.rowCount){await client.query('UPDATE users SET aura_points=aura_points+$1 WHERE id=$2',[m.points,referrer]);credited+=m.points;}}}
    await client.query('COMMIT');res.json({message:credited?`¡Invitación verificada! Se otorgaron ${credited} puntos Aura.`:'Invitación verificada.',credited,verified_users:count});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/payments/create-checkout', auth, async (req,res) => {
  const packageId=String(req.body?.package_id||'');if(!PRODUCTS[packageId])return res.status(400).json({error:'Paquete inválido'});
  return res.status(501).json({error:'La compra debe configurarse en RevenueCat antes de habilitar cobros reales.',package_id:packageId});
});

app.post('/api/gifts', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const recipientId=typeof req.body?.recipient_id==='string'?req.body.recipient_id.trim():'';const amount=Number(req.body?.points);
  if(!isValidId(recipientId)||!Number.isInteger(amount)||amount<=0)return res.status(400).json({error:'Datos de regalo inválidos'});if(recipientId===req.userId)return res.status(400).json({error:'No podés regalarte puntos a vos mismo'});
  const client=await pool.connect();try{await client.query('BEGIN');const sender=await getActiveUser(client,req.userId,true);if(!sender||sender.is_banned)throw Error('Cuenta no disponible');if(sender.giftable_points<amount)throw Error('No tenés suficientes puntos para regalar');const recipient=await getActiveUser(client,recipientId,true);if(!recipient||recipient.is_banned)throw Error('Destinatario no disponible');
    const today=await client.query(`SELECT COALESCE(SUM(points),0)::int total FROM gifts WHERE sender_id=$1 AND recipient_id=$2 AND created_at>=date_trunc('day',NOW())`,[req.userId,recipientId]);if(Number(today.rows[0].total)+amount>DAILY_GIFT_LIMIT_PER_RECIPIENT)throw Error(`Superaste el límite diario de ${DAILY_GIFT_LIMIT_PER_RECIPIENT} puntos para este destinatario`);
    await client.query('UPDATE users SET giftable_points=giftable_points-$1 WHERE id=$2',[amount,req.userId]);await client.query('UPDATE users SET aura_points=aura_points+$1 WHERE id=$2',[amount,recipientId]);await client.query('INSERT INTO gifts(sender_id,recipient_id,points) VALUES($1,$2,$3)',[req.userId,recipientId,amount]);await client.query('COMMIT');res.json({message:'Puntos regalados correctamente'});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/webhooks/revenuecat', async (req,res) => {
  if(!REVENUECAT_WEBHOOK_SECRET || req.header('Authorization')!==`Bearer ${REVENUECAT_WEBHOOK_SECRET}`)return res.status(401).json({error:'No autorizado'});
  const event=req.body?.event;if(!event||!['INITIAL_PURCHASE','NON_RENEWING_PURCHASE'].includes(event.type))return res.json({ignored:true});
  const userId=String(event.app_user_id||''),productId=String(event.product_id||''),transactionId=String(event.transaction_id||event.id||'');const product=PRODUCTS[productId];if(!isValidId(userId)||!product||!transactionId)return res.status(400).json({error:'Evento inválido'});
  const store=event.store==='PLAY_STORE'?'play_store':'app_store',client=await pool.connect();try{await client.query('BEGIN');if(!(await getActiveUser(client,userId,true)))throw Error('Usuario no encontrado');const ins=await client.query(`INSERT INTO purchases(user_id,product_id,store,transaction_id,points_credited) VALUES($1,$2,$3,$4,$5) ON CONFLICT(transaction_id) DO NOTHING RETURNING id`,[userId,productId,store,transactionId,product.points]);if(ins.rowCount)await client.query('UPDATE users SET giftable_points=giftable_points+$1 WHERE id=$2',[product.points,userId]);await client.query('COMMIT');res.json({message:ins.rowCount?'Puntos acreditados':'Ya procesada',points_credited:ins.rowCount?product.points:0});}catch(e){await client.query('ROLLBACK');res.status(500).json({error:'No se pudo procesar la compra'});}finally{client.release();}
});

app.post('/api/ads/reward', auth, async (req,res) => {
  const transactionId=typeof req.body?.transaction_id==='string'?req.body.transaction_id.trim():'';if(!transactionId||transactionId.length>200)return res.status(400).json({error:'transaction_id inválido'});
  const client=await pool.connect();try{await client.query('BEGIN');const u=await getActiveUser(client,req.userId,true);if(!u||u.is_banned)throw Error('Cuenta no disponible');const exists=await client.query('SELECT 1 FROM ad_rewards WHERE transaction_id=$1',[transactionId]);if(exists.rowCount){await client.query('COMMIT');return res.json({message:'Ya procesada',credited:0});}const today=await client.query(`SELECT COALESCE(SUM(points_credited),0)::int total FROM ad_rewards WHERE user_id=$1 AND created_at>=date_trunc('day',NOW())`,[req.userId]);const current=Number(today.rows[0].total);if(current>=DAILY_AD_POINTS_CAP){await client.query('COMMIT');return res.json({message:'Límite diario alcanzado',credited:0});}const credit=Math.min(POINTS_PER_AD,DAILY_AD_POINTS_CAP-current);await client.query('INSERT INTO ad_rewards(user_id,transaction_id,points_credited) VALUES($1,$2,$3)',[req.userId,transactionId,credit]);await client.query('UPDATE users SET giftable_points=giftable_points+$1 WHERE id=$2',[credit,req.userId]);await client.query('COMMIT');res.json({message:'Puntos acreditados',credited:credit});}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

async function expireLocalBattles(){
  const client=await pool.connect();try{await client.query('BEGIN');const q=await client.query(`SELECT * FROM battles WHERE mode='local' AND status='active' AND local_closes_at IS NOT NULL AND local_closes_at<=NOW() FOR UPDATE`);for(const b of q.rows){const winner=winnerFor(b,Number(b.votes_creator),Number(b.votes_opponent));if(winner){const loser=winner===b.local_participant_a?b.local_participant_b:b.local_participant_a;await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1',[winner]);await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1',[loser]);await client.query(`UPDATE battles SET status='completed',winner_id=$1,closed_at=NOW() WHERE id=$2`,[winner,b.id]);}else await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE id=$1`,[b.id]);}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');console.error('expireLocalBattles',e);}finally{client.release();}}
setInterval(expireLocalBattles,60000);

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Error de servidor'});});
app.use((req,res)=>res.status(404).json({error:'No encontrado'}));

const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`AURA STAR API v2.3 en puerto ${PORT}`));
