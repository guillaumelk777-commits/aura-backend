const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const CONFIG = {
  LOCAL_COST: Number(process.env.LOCAL_BATTLE_COST || 20),
  WIN_REWARD: Number(process.env.WIN_REWARD || 20),
  LOSS_PENALTY: Number(process.env.LOSS_PENALTY || 5),
  MIN_VOTES: 10,
  MIN_DIFF: 3,
  ARBITER_CLOSE_VOTES: 30,
  MAX_ACTIVE_PER_USER: 5,
  SUPABASE_URL: process.env.SUPABASE_URL || 'https://saqhaofycdjlwdauzhtv.supabase.co',
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY
};

const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const voteLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

// Middleware: valida el access token directamente contra Supabase Auth.
// Esto evita depender del JWT secret legado y funciona también con claves de firma asimétricas.
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token de sesión requerido', code: 'NO_TOKEN' });
  }
  const token = authHeader.slice(7).trim();
  try {
    const r = await fetch(`${CONFIG.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: CONFIG.SUPABASE_ANON_KEY || ''
      }
    });
    const user = await r.json().catch(() => null);
    if (!r.ok || !user?.id) {
      return res.status(401).json({ error: 'Sesión expirada o token inválido', code: 'INVALID_TOKEN' });
    }
    req.userId = user.id;
    req.authUser = user;
    next();
  } catch (err) {
    console.error('Supabase token validation:', err.message);
    return res.status(503).json({ error: 'No se pudo validar la sesión con Supabase.', code: 'AUTH_SERVICE_UNAVAILABLE' });
  }
}

const clean = s => String(s ?? '').trim();
const participantIds = b => b.mode === 'local' ? [b.local_participant_a, b.local_participant_b] : [b.creator_id, b.opponent_id];
const canResolve = (a, o) => a + o >= CONFIG.MIN_VOTES && Math.abs(a - o) >= CONFIG.MIN_DIFF;

async function expireLocalBattles(client = pool) {
  const result = await client.query(`SELECT * FROM battles WHERE mode='local' AND status='active' AND local_closes_at <= NOW() FOR UPDATE`);
  for (const b of result.rows) {
    if (canResolve(b.votes_creator, b.votes_opponent)) {
      await finishBattle(client, b, b.votes_creator > b.votes_opponent ? b.local_participant_a : b.local_participant_b);
    } else {
      await client.query(`UPDATE battles SET status='cancelled', closed_at=NOW() WHERE id=$1`, [b.id]);
    }
  }
}

async function finishBattle(client, b, winnerId) {
  if (!winnerId) return;
  const [a, o] = participantIds(b);
  const loserId = winnerId === a ? o : a;
  await client.query(`UPDATE users SET aura_points = aura_points + $1 WHERE id = $2`, [CONFIG.WIN_REWARD, winnerId]);
  if (loserId) {
    await client.query(`UPDATE users SET aura_points = GREATEST(0, aura_points - $1) WHERE id = $2`, [CONFIG.LOSS_PENALTY, loserId]);
  }
  await client.query(`UPDATE battles SET status='completed', winner_id=$1, closed_at=NOW() WHERE id=$2`, [winnerId, b.id]);
}

setInterval(() => expireLocalBattles().catch(e => console.error('expireLocalBattles:', e)), 60000);

app.get('/', (req, res) => res.json({ ok: true, service: 'AURA STAR API', version: '3.1' }));

// Sincronizar/Crear Usuario
app.post('/api/users', writeLimiter, requireAuth, async (req, res) => {
  try {
    const id = req.userId;
    const username = clean(req.body.username);
    const ageBracket = clean(req.body.age_bracket) || '18_plus';

    if (!username) return res.status(400).json({ error: 'El nombre de usuario es obligatorio.' });
    if (!['13_17', '18_plus'].includes(ageBracket)) return res.status(400).json({ error: 'Rango de edad inválido.' });

    const r = await pool.query(
      `INSERT INTO users(id, username, age_bracket) VALUES($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET username = EXCLUDED.username
       RETURNING *`,
      [id, username, ageBracket]
    );
    res.json(r.rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.code === '23505' ? 'Ese nombre de usuario ya está tomado.' : e.message });
  }
});

app.get('/api/users/ranking', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, username, aura_points, 
        (SELECT COUNT(*) FROM battles b WHERE b.winner_id = u.id) battles_won 
       FROM users u WHERE deleted_at IS NULL AND is_banned = false 
       ORDER BY aura_points DESC LIMIT 100`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.*, 
        (SELECT COUNT(*) FROM battles b WHERE b.status='completed' AND b.winner_id=u.id) battles_won, 
        (SELECT COUNT(*) FROM battles b WHERE b.status IN('completed','cancelled') AND (b.creator_id=u.id OR b.opponent_id=u.id OR b.local_participant_a=u.id OR b.local_participant_b=u.id)) battles_played 
       FROM users u WHERE u.id=$1 AND u.deleted_at IS NULL`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battles', async (req, res) => {
  try {
    await expireLocalBattles();
    const r = await pool.query(
      `SELECT b.*, u1.username creator_name, u2.username opponent_name, la.username local_a_name, lb.username local_b_name 
       FROM battles b 
       LEFT JOIN users u1 ON u1.id = b.creator_id 
       LEFT JOIN users u2 ON u2.id = b.opponent_id 
       LEFT JOIN users la ON la.id = b.local_participant_a 
       LEFT JOIN users lb ON lb.id = b.local_participant_b 
       WHERE b.status = 'active' AND b.hidden = false 
       ORDER BY b.created_at DESC LIMIT 100`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battles/local/search', async (req, res) => {
  try {
    await expireLocalBattles();
    const q = clean(req.query.q);
    if (q.length < 2) return res.json([]);
    const r = await pool.query(
      `SELECT b.id, b.title, b.category, b.theme, b.status, b.votes_creator, b.votes_opponent, b.local_closes_at, b.created_at, ua.username local_a_name, ub.username local_b_name 
       FROM battles b 
       JOIN users ua ON ua.id = b.local_participant_a 
       JOIN users ub ON ub.id = b.local_participant_b 
       WHERE b.mode = 'local' AND b.status = 'active' AND b.hidden = false AND b.title ILIKE '%' || $1 || '%' 
       ORDER BY b.created_at DESC LIMIT 30`,
      [q]
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battles/:id', async (req, res) => {
  try {
    await expireLocalBattles();
    const r = await pool.query(
      `SELECT b.*, u1.username creator_name, u2.username opponent_name, la.username local_a_name, lb.username local_b_name 
       FROM battles b 
       LEFT JOIN users u1 ON u1.id = b.creator_id 
       LEFT JOIN users u2 ON u2.id = b.opponent_id 
       LEFT JOIN users la ON la.id = b.local_participant_a 
       LEFT JOIN users lb ON lb.id = b.local_participant_b 
       WHERE b.id = $1`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Batalla no encontrada.' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear Batalla (Formatos Multimedia o Local)
app.post('/api/battles', writeLimiter, requireAuth, async (req, res) => {
  const creatorId = req.userId;
  const { mode = 'video', category, title, theme, media_url_creator, local_participant_a, local_participant_b, local_neutral = false } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const t = clean(title), m = clean(mode), cat = clean(category) || 'other';

    const u = await client.query(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL AND is_banned = false`, [creatorId]);
    if (!u.rows[0]) throw Error('Usuario no encontrado o deshabilitado.');

    const active = await client.query(
      `SELECT COUNT(*) FROM battles WHERE status = 'active' AND (creator_id = $1 OR opponent_id = $1 OR local_participant_a = $1 OR local_participant_b = $1)`,
      [creatorId]
    );
    if (Number(active.rows[0].count) >= CONFIG.MAX_ACTIVE_PER_USER) {
      throw Error(`Límite alcanzado: máximo ${CONFIG.MAX_ACTIVE_PER_USER} batallas activas simultáneas.`);
    }

    if (!['video', 'audio', 'photo', 'local'].includes(m)) throw Error('Modo de batalla no válido.');
    if (!t) throw Error('El título del desafío es obligatorio.');

    if (m === 'local') {
      const a = clean(local_participant_a);
      const b = clean(local_participant_b);
      if (!a || !b || a === b) throw Error('Se requieren dos participantes distintos.');
      if (!local_neutral && creatorId !== a && creatorId !== b) throw Error('Si no sos neutral, debés ser uno de los competidores.');
      if (local_neutral && (creatorId === a || creatorId === b)) throw Error('Un árbitro neutral no puede figurar como competidor.');

      const ps = await client.query(`SELECT id, age_bracket FROM users WHERE id = ANY($1) AND deleted_at IS NULL AND is_banned = false`, [[a, b]]);
      if (ps.rows.length !== 2) throw Error('Uno de los participantes no existe o está deshabilitado.');
      if (ps.rows[0].age_bracket !== ps.rows[1].age_bracket) throw Error('Los competidores deben pertenecer a la misma franja etaria.');

      const bal = await client.query(`SELECT giftable_points FROM users WHERE id = $1 FOR UPDATE`, [creatorId]);
      if (Number(bal.rows[0].giftable_points) < CONFIG.LOCAL_COST) {
        throw Error(`Requerís ${CONFIG.LOCAL_COST} puntos regalables para crear esta batalla local.`);
      }

      await client.query(`UPDATE users SET giftable_points = giftable_points - $1 WHERE id = $2`, [CONFIG.LOCAL_COST, creatorId]);

      const r = await client.query(
        `INSERT INTO battles(mode, creator_id, local_participant_a, local_participant_b, local_neutral, entry_cost_points, local_closes_at, category, title, theme) 
         VALUES('local', $1, $2, $3, $4, $5, NOW() + INTERVAL '2 hours', $6, $7, $8) RETURNING *`,
        [creatorId, a, b, !!local_neutral, CONFIG.LOCAL_COST, cat, t, clean(theme) || null]
      );
      await client.query('COMMIT');
      return res.status(201).json(r.rows[0]);
    }

    if (!media_url_creator || !/^https:\/\//i.test(media_url_creator)) {
      throw Error('Debe adjuntarse un archivo multimedia válido (HTTPS).');
    }

    const r = await client.query(
      `INSERT INTO battles(mode, creator_id, category, title, theme, media_url_creator) VALUES($1, $2, $3, $4, $5, $6) RETURNING *`,
      [m, creatorId, cat, t, clean(theme) || null, clean(media_url_creator)]
    );
    await client.query('COMMIT');
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Unirse a Batalla
app.post('/api/battles/:id/join', writeLimiter, requireAuth, async (req, res) => {
  const opponentId = req.userId;
  const { media_url } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM battles WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const b = r.rows[0];

    if (!b || b.status !== 'active') throw Error('La batalla no está activa.');
    if (b.mode === 'local') throw Error('Las batallas locales definen sus contrincantes al momento de la creación.');
    if (opponentId === b.creator_id) throw Error('No podés unirte a tu propia batalla.');

    const u = await client.query(`SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL AND is_banned = false`, [opponentId]);
    if (!u.rows[0]) throw Error('Usuario no encontrado.');

    const c = await client.query(`SELECT age_bracket FROM users WHERE id = $1`, [b.creator_id]);
    if (c.rows[0].age_bracket !== u.rows[0].age_bracket) throw Error('Ambos competidores deben pertenecer a la misma franja etaria.');

    if (!media_url || !/^https:\/\//i.test(media_url)) throw Error('Archivo multimedia no válido.');

    await client.query(`UPDATE battles SET opponent_id = $1, media_url_opponent = $2 WHERE id = $3`, [opponentId, clean(media_url), b.id]);
    await client.query('COMMIT');
    res.json({ message: '¡Te uniste a la batalla!', id: b.id });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Registrar Voto
app.post('/api/battles/:id/vote', voteLimiter, requireAuth, async (req, res) => {
  const voterId = req.userId;
  const { voted_user_id } = req.body;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM battles WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const b = r.rows[0];

    if (!b || b.status !== 'active') throw Error('La batalla no está activa para recibir votos.');
    if (b.mode !== 'local' && !b.opponent_id) throw Error('La batalla debe tener ambos participantes para poder votar.');

    const target = clean(voted_user_id);
    const [pa, pb] = participantIds(b);

    if (voterId === pa || voterId === pb) throw Error('No tenés permitido votar en tu propia batalla.');
    if (b.mode === 'local' && b.local_neutral && voterId === b.creator_id) throw Error('El árbitro neutral no puede votar.');
    if (target !== pa && target !== pb) throw Error('Destinatario de voto inválido.');

    await client.query(`INSERT INTO votes(battle_id, voter_id, voted_user_id) VALUES($1, $2, $3)`, [b.id, voterId, target]);

    const a = b.votes_creator + (target === pa ? 1 : 0);
    const o = b.votes_opponent + (target === pb ? 1 : 0);

    await client.query(`UPDATE battles SET votes_creator = $1, votes_opponent = $2 WHERE id = $3`, [a, o, b.id]);

    let completed = false;
    if (canResolve(a, o)) {
      await finishBattle(client, b, a > o ? pa : pb);
      completed = true;
    }

    await client.query('COMMIT');
    res.json({ message: '¡Voto registrado!', completed, votes_creator: a, votes_opponent: o });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.code === '23505' ? 'Ya emitiste tu voto en este desafío.' : e.message });
  } finally { client.release(); }
});

// Cierre de Batalla por Árbitro Neutral
app.post('/api/battles/:id/arbiter-close', writeLimiter, requireAuth, async (req, res) => {
  const arbiterId = req.userId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT * FROM battles WHERE id = $1 FOR UPDATE`, [req.params.id]);
    const b = r.rows[0];

    if (!b || b.status !== 'active' || b.mode !== 'local' || !b.local_neutral) {
      throw Error('Esta acción es exclusiva para árbitros de batallas locales.');
    }
    if (arbiterId !== b.creator_id) throw Error('Solo el creador/árbitro designado puede cerrar esta batalla.');

    const total = b.votes_creator + b.votes_opponent;
    const diff = Math.abs(b.votes_creator - b.votes_opponent);

    if (total < CONFIG.ARBITER_CLOSE_VOTES || diff < CONFIG.MIN_DIFF) {
      throw Error(`El cierre anticipado requiere un mínimo de ${CONFIG.ARBITER_CLOSE_VOTES} votos y una diferencia de ${CONFIG.MIN_DIFF}.`);
    }

    const [pa, pb] = participantIds(b);
    await finishBattle(client, b, b.votes_creator > b.votes_opponent ? pa : pb);
    await client.query('COMMIT');
    res.json({ message: 'Batalla cerrada y resuelta exitosamente por el árbitro.' });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.message });
  } finally { client.release(); }
});

// Reportes
app.post('/api/battles/:id/report', writeLimiter, requireAuth, async (req, res) => {
  const reporterId = req.userId;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query(`INSERT INTO reports(battle_id, reporter_id, reason) VALUES($1, $2, $3)`, [req.params.id, reporterId, clean(req.body.reason || 'Reporte de contenido')]);
    const c = await client.query(`UPDATE battles SET report_count = report_count + 1, hidden = (report_count + 1) >= 3 WHERE id = $1 RETURNING hidden`, [req.params.id]);
    await client.query('COMMIT');
    res.json({ message: 'Reporte registrado.', hidden: c.rows[0].hidden });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: e.code === '23505' ? 'Ya enviaste un reporte sobre este desafío.' : e.message });
  } finally { client.release(); }
});

// Eliminar cuenta propia
app.delete('/api/users/:id', requireAuth, async (req, res) => {
  if (req.params.id !== req.userId) return res.status(403).json({ error: 'Operación no autorizada.' });
  try {
    await pool.query(`UPDATE users SET deleted_at = NOW() WHERE id = $1`, [req.userId]);
    res.json({ message: 'Cuenta eliminada correctamente.' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AURA STAR API v3.1 (JWT Auth) escuchando en puerto ${PORT}`));
