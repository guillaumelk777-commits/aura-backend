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
const POINTS_PER_AD = 5;
const DAILY_AD_POINTS_CAP = 60;
const LOCAL_COST = 20;
const TOURNAMENT_COST = Number(process.env.TOURNAMENT_COST || 20);
const LOCAL_HOURS = 2;
const TOURNAMENT_MAX_HOURS = 6;
const TOURNAMENT_TIEBREAK_MINUTES = Number(process.env.TOURNAMENT_TIEBREAK_MINUTES || 30);
const ARBITER_CLOSE_VOTES = 30;
const MIN_VOTES = 10;
const MIN_DIFF = 3;

// Configurable. Se cuentan usuarios únicos que completan el reclamo del enlace.
// Si la regla comercial definida previamente cambia, solo se modifica esta variable en Render.
const SHARE_REWARD_MILESTONES = parseMilestones(process.env.SHARE_REWARD_MILESTONES || '5:5,10:10,25:25');
const SHARE_BASE_URL = (process.env.SHARE_BASE_URL || process.env.FRONTEND_ORIGIN || '').replace(/\/$/, '');
const SHARE_TOKEN_SECRET = process.env.SHARE_TOKEN_SECRET || '';
const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET || '';

const PRODUCTS = {
  starter: { points: 50 },
  plus: { points: 120 },
  pro: { points: 300 },
  mega: { points: 700 },
  aura_points_small: { points: 100 },
  aura_points_medium: { points: 300 },
  aura_points_large: { points: 700 }
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
function errorMessage(e) { return e && e.message ? e.message : 'Error interno'; }

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

async function getActiveUser(clientOrPool, userId, forUpdate = false) {
  const q = await clientOrPool.query(
    `SELECT id,username,aura_points,giftable_points,age_bracket,is_banned,deleted_at,created_at
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
function validLatLng(lat, lng) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Number(lat) >= -90 && Number(lat) <= 90 && Number(lng) >= -180 && Number(lng) <= 180;
}
function publicApproxCoord(v) { return v == null ? null : Number(Number(v).toFixed(2)); }
function bracketWinnerFor(b, vc, vo) {
  return winnerFor(b, vc, vo);
}

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

app.get('/', (req,res) => res.json({ app:'AURA STAR', version:'4.1', status:'ok', share_milestones: SHARE_REWARD_MILESTONES }));

app.post('/api/users', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().slice(0,40) : null;
  const age = req.body?.age_bracket;
  if (age && !AGE_BRACKETS.includes(age)) return res.status(400).json({error:'age_bracket inválido'});
  if (!username) return res.status(400).json({error:'El nombre de usuario es obligatorio'});
  try {
    const q = await pool.query(
      `INSERT INTO users(id,username,age_bracket) VALUES($1,$2,$3)
       ON CONFLICT(id) DO UPDATE SET username=COALESCE(NULLIF($2,''),users.username),age_bracket=COALESCE($3,users.age_bracket)
       RETURNING id,username,aura_points,giftable_points,age_bracket,is_banned,created_at`,
      [req.userId,username,age || null]
    );
    res.json(q.rows[0]);
  } catch(e){ console.error(e); res.status(500).json({error:'No se pudo guardar el usuario'}); }
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
      if(neutral && req.userId!==req.userId)throw Error('Árbitro inválido');
      const pa=await getActiveUser(client,a);const pb=await getActiveUser(client,b);if(!pa||!pb)throw Error('Uno de los competidores no existe o no está disponible.');
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

app.post('/api/battles/:id/join', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const url=req.body?.media_url_opponent||req.body?.media_url;if(!validateMediaUrl(url))return res.status(400).json({error:'La participación del oponente es obligatoria'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const user=await getActiveUser(client,req.userId,true);if(!user)throw Error('Usuario no registrado');if(user.is_banned)throw Error('Cuenta suspendida');
    if((await activeBattleCount(client,req.userId))>=5)throw Error('Límite alcanzado: máximo 5 batallas activas simultáneas.');
    const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=q.rows[0];if(!b||b.status!=='active')throw Error('La batalla no está activa');
    if(b.mode==='local')throw Error('Las batallas locales no se aceptan por este enlace');if(b.creator_id===req.userId)throw Error('No podés unirte a tu propia batalla');if(b.opponent_id)throw Error('La batalla ya tiene oponente');
    const creator=await getActiveUser(client,b.creator_id);if(!creator)throw Error('Creador no disponible');
    if(creator.age_bracket&&user.age_bracket&&creator.age_bracket!==user.age_bracket)throw Error('Esta batalla es de otra franja etaria.');
    const r=await client.query(`UPDATE battles SET opponent_id=$1,media_url_opponent=$2 WHERE id=$3 AND opponent_id IS NULL RETURNING *`,[req.userId,url,req.params.id]);if(!r.rowCount)throw Error('Otro usuario aceptó la batalla primero');
    await client.query('COMMIT');res.json(r.rows[0]);
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/battles/:id/vote', auth, rateLimit({windowMs:60000,max:30}), async (req,res) => {
  const target=req.body?.voted_user_id;if(!isValidId(target))return res.status(400).json({error:'Participante inválido'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');const voter=await getActiveUser(client,req.userId,true);if(!voter)throw Error('Usuario no registrado');if(voter.is_banned)throw Error('Cuenta suspendida');
    const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=q.rows[0];if(!b||b.status!=='active')throw Error('La batalla no está activa');if(b.hidden)throw Error('Esta batalla está en revisión');
    if(b.mode!=='local' && (!b.opponent_id||!b.media_url_creator||!b.media_url_opponent))throw Error('La votación comienza cuando ambos participantes presentaron su participación.');
    const pA=b.mode==='local'?b.local_participant_a:b.creator_id, pB=b.mode==='local'?b.local_participant_b:b.opponent_id;
    if(req.userId===pA||req.userId===pB)throw Error('No podés votar en tu propia batalla');
    if(target!==pA&&target!==pB)throw Error('Participante inválido');
    const prior=await client.query('SELECT 1 FROM votes WHERE battle_id=$1 AND voter_id=$2',[b.id,req.userId]);if(prior.rowCount)throw Error('Ya votaste en esta batalla');
    await client.query('INSERT INTO votes(battle_id,voter_id,voted_user_id) VALUES($1,$2,$3)',[b.id,req.userId,target]);
    const vc=Number(b.votes_creator)+(target===pA?1:0),vo=Number(b.votes_opponent)+(target===pB?1:0);
    let winner=null;
    if(b.mode==='local'){
      winner=(vc+vo>=MIN_VOTES && Math.abs(vc-vo)>=MIN_DIFF && vc!==vo) ? (vc>vo?pA:pB) : null;
      if(winner){const loser=winner===pA?pB:pA;await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1',[winner]);await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1',[loser]);await client.query(`UPDATE battles SET votes_creator=$1,votes_opponent=$2,status='completed',winner_id=$3,closed_at=NOW() WHERE id=$4`,[vc,vo,winner,b.id]);await advanceTournamentMatch(client,b,winner);}
    } else winner=await settleBattle(client,b,vc,vo);
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
    await client.query(`UPDATE battles SET status='completed',winner_id=$1,closed_at=NOW() WHERE id=$2`,[winner,b.id]);await advanceTournamentMatch(client,b,winner);await client.query('COMMIT');res.json({completed:true,winner_id:winner});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

// Advance a completed tournament match. A match can only advance after its battle resolves.
async function advanceTournamentMatch(client,b,winnerId){
  if(!b.tournament_id||!b.tournament_match_id||!winnerId)return;
  const tmq=await client.query('SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE',[b.tournament_match_id]);const tm=tmq.rows[0];if(!tm||tm.status==='completed')return;
  await client.query(`UPDATE tournament_matches SET status='completed',winner_id=$1 WHERE id=$2`,[winnerId,tm.id]);
  await client.query(`UPDATE tournament_participants SET status=CASE WHEN user_id=$1 THEN 'active' ELSE 'eliminated' END WHERE tournament_id=$2 AND status='active'`,[winnerId,b.tournament_id]);
  const tq=(await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE',[b.tournament_id])).rows[0];if(!tq)return;
  const nextRound=tm.round+1;
  const totalMatches=Math.floor(tq.size/Math.pow(2,nextRound));
  if(totalMatches<1){await client.query(`UPDATE tournament_participants SET status='winner' WHERE tournament_id=$1 AND user_id=$2`,[tq.id,winnerId]);
    await client.query(`UPDATE tournaments SET status='completed',current_round=$1,closed_at=NOW() WHERE id=$2`,[tm.round,tq.id]);return;}
  const nextMatchNumber=Math.ceil(tm.match_number/2);
  let nm=(await client.query('SELECT * FROM tournament_matches WHERE tournament_id=$1 AND round=$2 AND match_number=$3 FOR UPDATE',[tq.id,nextRound,nextMatchNumber])).rows[0];
  if(!nm){const nr=await client.query(`INSERT INTO tournament_matches(tournament_id,round,match_number,status) VALUES($1,$2,$3,'waiting') RETURNING *`,[tq.id,nextRound,nextMatchNumber]);nm=nr.rows[0];}
  const side=tm.match_number%2===1?'player_a_id':'player_b_id';
  await client.query(`UPDATE tournament_matches SET ${side}=$1 WHERE id=$2`,[winnerId,nm.id]);
  const fresh=(await client.query('SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE',[nm.id])).rows[0];
  if(fresh.player_a_id&&fresh.player_b_id&&fresh.status!=='active'){
    await client.query(`UPDATE tournament_matches SET status='ready' WHERE id=$1`,[fresh.id]);
    const br=await client.query(`INSERT INTO battles(creator_id,mode,category,title,theme,local_participant_a,local_participant_b,local_neutral,local_closes_at,status,tournament_id,tournament_match_id,tournament_round,tournament_match)
      VALUES($1,'local',$2,$3,$4,$5,$6,true,NOW()+INTERVAL '2 hours','active',$7,$8,$9,$10) RETURNING id`,[tq.organizer_id,tq.category,`${tq.title} · Ronda ${nextRound}`,tq.description,fresh.player_a_id,fresh.player_b_id,tq.id,fresh.id,nextRound,nextMatchNumber]);
    await client.query(`UPDATE tournament_matches SET status='active' WHERE id=$1`,[fresh.id]);
    await client.query(`UPDATE tournaments SET current_round=$1,status='live' WHERE id=$2`,[nextRound,tq.id]);
  }
}

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
  if(!SHARE_TOKEN_SECRET) return res.status(500).json({error:'SHARE_TOKEN_SECRET no configurado'});
  try{
    // Token estable por usuario: el enlace no cambia cada vez que se abre el perfil.
    // El cliente nunca puede elegir el referrer; el servidor lo deriva del token.
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

// ============================================================
// EVENTOS / TORNEOS LOCALES
// ============================================================
app.get('/api/events/local', auth, async (req,res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  const hasCoords = validLatLng(lat,lng);
  try {
    const me=await getActiveUser(pool,req.userId);
    if(!me)return res.status(404).json({error:'Usuario no encontrado'});
    const q = await pool.query(`SELECT t.id,t.title,t.category,t.description,t.size,t.age_bracket,t.status,t.starts_at,t.closes_at,
      t.current_round,t.event_code,u.username organizer_name,
      (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id=t.id) participant_count
      FROM tournaments t LEFT JOIN users u ON u.id=t.organizer_id
      WHERE t.mode='local' AND t.status IN ('registration','live') AND t.age_bracket=$1
      ORDER BY t.created_at DESC LIMIT 50`,[me.age_bracket]);
    const rows=q.rows.map(r=>({...r,proximity_label:hasCoords?'Cerca de vos':'Evento local'}));
    // Privacy: exact coordinates are never returned by this endpoint.
    res.json({events:rows,nearby_requested:hasCoords});
  } catch(e){res.status(500).json({error:'No se pudieron cargar los eventos locales'});}
});

app.post('/api/tournaments', auth, rateLimit({windowMs:60000,max:10}), async (req,res) => {
  const title=typeof req.body?.title==='string'?req.body.title.trim().slice(0,80):'';
  const category=String(req.body?.category||'');
  const description=typeof req.body?.description==='string'?req.body.description.trim().slice(0,300):null;
  const size=Number(req.body?.size);
  const age=String(req.body?.age_bracket||'');
  const lat=req.body?.latitude==null?null:Number(req.body.latitude), lng=req.body?.longitude==null?null:Number(req.body.longitude);
  const disclaimerAccepted=req.body?.organizer_disclaimer_accepted===true;
  if(!title||!CATEGORIES.includes(category)||![4,8].includes(size)||!AGE_BRACKETS.includes(age))return res.status(400).json({error:'Datos del torneo inválidos'});
  if((lat==null)!==(lng==null) || (lat!=null&&!validLatLng(lat,lng)))return res.status(400).json({error:'Ubicación inválida'});
  if(!disclaimerAccepted)return res.status(400).json({error:'Debés aceptar el aviso de organizador del evento.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const user=await getActiveUser(client,req.userId,true);if(!user||user.is_banned)throw Error('Cuenta no disponible');
    if(!user.age_bracket)throw Error('Tu perfil debe tener una franja etaria antes de crear un torneo.');
    if(user.age_bracket!==age)throw Error('El organizador debe pertenecer a la misma franja etaria del torneo.');
    if(user.giftable_points<TOURNAMENT_COST)throw Error(`Necesitás ${TOURNAMENT_COST} puntos regalables para crear el torneo.`);
    const active=await client.query(`SELECT COUNT(*)::int count FROM tournaments WHERE organizer_id=$1 AND status IN ('registration','live')`,[req.userId]);
    if(Number(active.rows[0].count)>=3)throw Error('Máximo 3 torneos activos por organizador.');
    await client.query('UPDATE users SET giftable_points=giftable_points-$1 WHERE id=$2',[TOURNAMENT_COST,req.userId]);
    const code=newToken().slice(0,10).toUpperCase();
    const r=await client.query(`INSERT INTO tournaments(organizer_id,title,category,description,size,age_bracket,mode,status,starts_at,closes_at,latitude,longitude,event_code,organizer_disclaimer_accepted,entry_cost_points)
      VALUES($1,$2,$3,$4,$5,$6,'local','registration',COALESCE($7,NOW()),COALESCE($7,NOW())+INTERVAL '6 hours',$8,$9,$10,true,$11) RETURNING *`,
      [req.userId,title,category,description,size,age,req.body?.starts_at||null,lat,lng,code,TOURNAMENT_COST]);
    await client.query('COMMIT');res.status(201).json(r.rows[0]);
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.get('/api/tournaments/:id', auth, async (req,res) => {
  if(!isUuid(req.params.id))return res.status(400).json({error:'ID de torneo inválido'});
  try{
    const t=await pool.query(`SELECT t.id,t.title,t.category,t.description,t.size,t.age_bracket,t.mode,t.status,t.starts_at,t.closes_at,t.current_round,t.event_code,t.organizer_id,
      t.latitude,t.longitude,u.username organizer_name,
      (SELECT COUNT(*)::int FROM tournament_participants tp WHERE tp.tournament_id=t.id) participant_count
      FROM tournaments t LEFT JOIN users u ON u.id=t.organizer_id WHERE t.id=$1`,[req.params.id]);
    if(!t.rows[0])return res.status(404).json({error:'Torneo no encontrado'});
    const p=await pool.query(`SELECT tp.user_id,tp.seed,tp.slot,tp.status,tp.joined_at,u.username FROM tournament_participants tp JOIN users u ON u.id=tp.user_id WHERE tp.tournament_id=$1 ORDER BY tp.slot`,[req.params.id]);
    const m=await pool.query(`SELECT tm.id,tm.round,tm.match_number,tm.status,tm.player_a_id,tm.player_b_id,tm.winner_id,b.id battle_id,b.votes_creator,b.votes_opponent,b.local_closes_at,ua.username player_a_name,ub.username player_b_name
      FROM tournament_matches tm LEFT JOIN battles b ON b.tournament_match_id=tm.id LEFT JOIN users ua ON ua.id=tm.player_a_id LEFT JOIN users ub ON ub.id=tm.player_b_id WHERE tm.tournament_id=$1 ORDER BY tm.round,tm.match_number`,[req.params.id]);
    const row=t.rows[0];row.latitude=publicApproxCoord(row.latitude);row.longitude=publicApproxCoord(row.longitude);delete row.organizer_id;
    res.json({tournament:row,participants:p.rows,matches:m.rows});
  }catch(e){res.status(500).json({error:'No se pudo cargar el torneo'});}
});

app.post('/api/tournaments/:id/join', auth, rateLimit({windowMs:60000,max:20}), async (req,res) => {
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const user=await getActiveUser(client,req.userId,true);if(!user||user.is_banned)throw Error('Cuenta no disponible');
    const tq=await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE',[req.params.id]);const t=tq.rows[0];
    if(!t||t.status!=='registration')throw Error('El torneo no está abierto a inscripciones.');
    if(t.organizer_id===req.userId)throw Error('El organizador es el árbitro neutral y no participa como competidor en este torneo.');
    if(user.age_bracket!==t.age_bracket)throw Error('Este torneo pertenece a otra franja etaria.');
    const exists=await client.query('SELECT 1 FROM tournament_participants WHERE tournament_id=$1 AND user_id=$2',[t.id,req.userId]);if(exists.rowCount)throw Error('Ya estás inscripto en este torneo.');
    const count=await client.query('SELECT COUNT(*)::int count FROM tournament_participants WHERE tournament_id=$1',[t.id]);if(Number(count.rows[0].count)>=t.size)throw Error('El torneo ya está completo.');
    await client.query('INSERT INTO tournament_participants(tournament_id,user_id,slot,status) VALUES($1,$2,$3,\'registered\')',[t.id,req.userId,Number(count.rows[0].count)+1]);
    const after=Number(count.rows[0].count)+1;
    if(after===t.size){
      const ps=(await client.query(`SELECT user_id,slot FROM tournament_participants WHERE tournament_id=$1 ORDER BY slot`,[t.id])).rows;
      for(let i=0;i<ps.length;i++){await client.query("UPDATE tournament_participants SET seed=$1,status='active' WHERE tournament_id=$2 AND user_id=$3",[i+1,t.id,ps[i].user_id]);}
      const pairs=[];for(let i=0;i<t.size;i+=2)pairs.push([ps[i].user_id,ps[i+1].user_id]);
      for(let i=0;i<pairs.length;i++){
        const mr=await client.query(`INSERT INTO tournament_matches(tournament_id,round,match_number,player_a_id,player_b_id,status) VALUES($1,1,$2,$3,$4,'ready') RETURNING id`,[t.id,i+1,pairs[i][0],pairs[i][1]]);
        await client.query(`INSERT INTO battles(creator_id,mode,category,title,theme,local_participant_a,local_participant_b,local_neutral,local_closes_at,status,tournament_id,tournament_match_id,tournament_round,tournament_match)
          VALUES($1,'local',$2,$3,$4,$5,$6,true,NOW()+INTERVAL '2 hours','active',$7,$8,1,$9)`,[t.organizer_id,t.category,`${t.title} · Ronda 1`,t.description,pairs[i][0],pairs[i][1],t.id,mr.rows[0].id,i+1]);
      }
      await client.query(`UPDATE tournaments SET status='live',current_round=1 WHERE id=$1`,[t.id]);
    }
    await client.query('COMMIT');res.json({message:'Inscripción realizada',started:after===t.size});
  }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

app.post('/api/tournaments/:id/cancel', auth, rateLimit({windowMs:60000,max:10}), async (req,res) => {
  const client=await pool.connect();try{await client.query('BEGIN');const t=(await client.query('SELECT * FROM tournaments WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];if(!t)throw Error('Torneo no encontrado');if(t.organizer_id!==req.userId)throw Error('Solo el organizador puede cancelar el torneo.');if(t.status==='completed'||t.status==='cancelled')throw Error('El torneo ya está cerrado.');
    await client.query(`UPDATE tournaments SET status='cancelled',closed_at=NOW() WHERE id=$1`,[t.id]);await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE tournament_id=$1 AND status='active'`,[t.id]);await client.query('COMMIT');res.json({message:'Torneo cancelado'});
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

// Este endpoint queda reservado para un adaptador SSV que valide criptográficamente el callback de AdMob.
// No acepta user_id desde el cliente y no debe exponerse como mecanismo de recompensa.
app.post('/api/ads/reward', auth, async (req,res) => {
  const transactionId=typeof req.body?.transaction_id==='string'?req.body.transaction_id.trim():'';if(!transactionId||transactionId.length>200)return res.status(400).json({error:'transaction_id inválido'});
  const client=await pool.connect();try{await client.query('BEGIN');const u=await getActiveUser(client,req.userId,true);if(!u||u.is_banned)throw Error('Cuenta no disponible');const exists=await client.query('SELECT 1 FROM ad_rewards WHERE transaction_id=$1',[transactionId]);if(exists.rowCount){await client.query('COMMIT');return res.json({message:'Ya procesada',credited:0});}const today=await client.query(`SELECT COALESCE(SUM(points_credited),0)::int total FROM ad_rewards WHERE user_id=$1 AND created_at>=date_trunc('day',NOW())`,[req.userId]);const current=Number(today.rows[0].total);if(current>=DAILY_AD_POINTS_CAP){await client.query('COMMIT');return res.json({message:'Límite diario alcanzado',credited:0});}const credit=Math.min(POINTS_PER_AD,DAILY_AD_POINTS_CAP-current);await client.query('INSERT INTO ad_rewards(user_id,transaction_id,points_credited) VALUES($1,$2,$3)',[req.userId,transactionId,credit]);await client.query('UPDATE users SET giftable_points=giftable_points+$1 WHERE id=$2',[credit,req.userId]);await client.query('COMMIT');res.json({message:'Puntos acreditados',credited:credit});}catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
});

// Cierre automático de batallas locales vencidas: si cumple mínimos, gana quien tenga mayor voto; si no, cancela sin Aura.
async function expireLocalBattles(){
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query(`SELECT * FROM battles WHERE mode='local' AND status='active' AND local_closes_at IS NOT NULL AND local_closes_at<=NOW() FOR UPDATE`);
    for(const b of q.rows){
      const winner=winnerFor(b,Number(b.votes_creator),Number(b.votes_opponent));
      if(winner){
        const loser=winner===b.local_participant_a?b.local_participant_b:b.local_participant_a;
        await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1',[winner]);
        await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1',[loser]);
        await client.query(`UPDATE battles SET status='completed',winner_id=$1,closed_at=NOW() WHERE id=$2`,[winner,b.id]);
        await advanceTournamentMatch(client,b,winner);
        continue;
      }
      if(b.tournament_id && b.tournament_match_id){
        const tm=(await client.query('SELECT * FROM tournament_matches WHERE id=$1 FOR UPDATE',[b.tournament_match_id])).rows[0];
        if(tm && tm.status==='active' && !tm.tiebreak_used){
          await client.query(`UPDATE tournament_matches SET tiebreak_used=true WHERE id=$1`,[tm.id]);
          await client.query(`UPDATE battles SET local_closes_at=NOW()+($1::text||' minutes')::interval WHERE id=$2`,[TOURNAMENT_TIEBREAK_MINUTES,b.id]);
          continue;
        }
        if(tm){
          await client.query(`UPDATE tournament_matches SET status='cancelled' WHERE id=$1`,[tm.id]);
          await client.query(`UPDATE tournaments SET status='cancelled',closed_at=NOW() WHERE id=$1`,[b.tournament_id]);
          await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE tournament_id=$1 AND status='active'`,[b.tournament_id]);
          continue;
        }
      }
      await client.query(`UPDATE battles SET status='cancelled',closed_at=NOW() WHERE id=$1`,[b.id]);
    }
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');console.error('expireLocalBattles',e);}finally{client.release();}
}
setInterval(expireLocalBattles,60000);

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({error:'Error de servidor'});});
app.use((req,res)=>res.status(404).json({error:'No encontrado'}));

const PORT=process.env.PORT||3000;app.listen(PORT,()=>console.log(`AURA STAR API v4.1 en puerto ${PORT}`));
