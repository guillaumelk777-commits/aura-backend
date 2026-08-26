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
pool.on('error', (err) => console.error('Error inesperado en el pool de Postgres', err));

const CATEGORIES = ['gaming', 'freestyle', 'dance'];
const REPORT_HIDE_THRESHOLD = 3;
const DAILY_GIFT_LIMIT_PER_RECIPIENT = 50;
const AGE_BRACKETS = ['13_17', '18_plus'];
const POINTS_PER_AD = 5;
const DAILY_AD_POINTS_CAP = 60;
const ADS_SSV_SECRET = process.env.ADS_SSV_SECRET;

const PRODUCTS = {
  'aura_points_small': { points: 100, store_price_usd: 1.99 },
  'aura_points_medium': { points: 300, store_price_usd: 4.99 },
  'aura_points_large': { points: 700, store_price_usd: 9.99 },
};

const REVENUECAT_WEBHOOK_SECRET = process.env.REVENUECAT_WEBHOOK_SECRET;

const writeLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
const voteLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });

function isValidId(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 100;
}

app.get('/', (req, res) => res.json({ app: 'AURA', status: 'ok', message: '⚡ API de AURA funcionando correctamente' }));

app.post('/api/users', writeLimiter, async (req, res) => {
  const { id, username, age_bracket } = req.body || {};
  if (!isValidId(id)) return res.status(400).json({ error: 'id es obligatorio' });
  const cleanUsername = typeof username === 'string' ? username.trim().slice(0, 40) : null;
  if (age_bracket && !AGE_BRACKETS.includes(age_bracket)) {
    return res.status(400).json({ error: 'age_bracket inválido' });
  }
  try {
    const q = await pool.query(
      `INSERT INTO users(id, username, age_bracket) VALUES($1, $2, $3)
       ON CONFLICT(id) DO UPDATE SET
         username = COALESCE(NULLIF($2, ''), users.username),
         age_bracket = COALESCE($3, users.age_bracket)
       RETURNING id, username, aura_points, giftable_points, age_bracket, is_banned, created_at`,
      [id, cleanUsername, age_bracket || null]
    );
    res.json(q.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/ranking', async (req, res) => {
  try {
    const q = await pool.query(
      `SELECT id, username, aura_points FROM users
       WHERE deleted_at IS NULL AND is_banned = false
       ORDER BY aura_points DESC NULLS LAST LIMIT 50`
    );
    res.json(q.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users/:id', async (req, res) => {
  try {
    const q = await pool.query(
      'SELECT id, username, aura_points, created_at FROM users WHERE id=$1 AND deleted_at IS NULL',
      [req.params.id]
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(q.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/users/:id', async (req, res) => {
  try {
    const q = await pool.query(
      `UPDATE users SET username = NULL, is_banned = true, deleted_at = NOW()
       WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [req.params.id]
    );
    if (!q.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Cuenta eliminada' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battles', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 30, 50);
  try {
    const q = await pool.query(
      `SELECT * FROM battles WHERE status='active' AND hidden = false ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    res.json(q.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/battles/:id', async (req, res) => {
  try {
    const q = await pool.query('SELECT * FROM battles WHERE id=$1', [req.params.id]);
    if (!q.rows[0]) return res.status(404).json({ error: 'Batalla no encontrada' });
    res.json(q.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/battles', writeLimiter, async (req, res) => {
  const { creator_id, category, title, media_url_creator } = req.body || {};
  if (!isValidId(creator_id) || !category || !title) {
    return res.status(400).json({ error: 'creator_id, category y title son obligatorios' });
  }
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: 'Categoría inválida' });
  const cleanTitle = String(title).trim().slice(0, 80);
  if (!cleanTitle) return res.status(400).json({ error: 'El título no puede estar vacío' });
  if (media_url_creator && !/^https:\/\//i.test(media_url_creator)) {
    return res.status(400).json({ error: 'URL de media inválida' });
  }
  try {
    const user = await pool.query('SELECT is_banned FROM users WHERE id=$1 AND deleted_at IS NULL', [creator_id]);
    if (!user.rows[0]) return res.status(400).json({ error: 'Usuario no registrado' });
    if (user.rows[0].is_banned) return res.status(403).json({ error: 'Cuenta suspendida' });

    const active = await pool.query("SELECT COUNT(*) FROM battles WHERE creator_id=$1 AND status='active'", [creator_id]);
    if (Number(active.rows[0].count) >= 5) return res.status(400).json({ error: 'Límite alcanzado: Máximo 5 batallas activas simultáneas.' });

    const q = await pool.query(
      `INSERT INTO battles(creator_id, category, title, media_url_creator, status, votes_creator, votes_opponent)
       VALUES($1, $2, $3, $4, 'active', 0, 0) RETURNING *`,
      [creator_id, category, cleanTitle, media_url_creator || null]
    );
    res.status(201).json(q.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/battles/:id/join', writeLimiter, async (req, res) => {
  const { opponent_id, media_url_opponent } = req.body || {};
  if (!isValidId(opponent_id)) return res.status(400).json({ error: 'opponent_id es obligatorio' });
  if (media_url_opponent && !/^https:\/\//i.test(media_url_opponent)) {
    return res.status(400).json({ error: 'URL de media inválida' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT is_banned, age_bracket FROM users WHERE id=$1 AND deleted_at IS NULL', [opponent_id]);
    if (!user.rows[0]) throw Error('Usuario no registrado.');
    if (user.rows[0].is_banned) throw Error('Cuenta suspendida.');

    const q = await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE', [req.params.id]);
    const b = q.rows[0];
    if (!b || b.status !== 'active') throw Error('La batalla no está activa o no existe.');
    if (b.creator_id === opponent_id) throw Error('No puedes unirte a tu propia batalla.');
    if (b.opponent_id) throw Error('La batalla ya tiene oponente.');

    const creator = await client.query('SELECT age_bracket FROM users WHERE id=$1', [b.creator_id]);
    if (creator.rows[0]?.age_bracket && user.rows[0].age_bracket && creator.rows[0].age_bracket !== user.rows[0].age_bracket) {
      throw Error('Esta batalla es de otra franja etaria.');
    }

    const r = await client.query('UPDATE battles SET opponent_id=$1, media_url_opponent=$2 WHERE id=$3 RETURNING *', [opponent_id, media_url_opponent || null, req.params.id]);
    await client.query('COMMIT');
    res.json(r.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/battles/:id/vote', voteLimiter, async (req, res) => {
  const battleId = req.params.id;
  const { voter_id, voted_user_id } = req.body || {};
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query('SELECT is_banned FROM users WHERE id=$1 AND deleted_at IS NULL', [voter_id]);
    if (!user.rows[0]) throw Error('Usuario no registrado.');
    if (user.rows[0].is_banned) throw Error('Cuenta suspendida.');

    const q = await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE', [battleId]);
    const b = q.rows[0];
    if (!b || b.status !== 'active') throw Error('La batalla no está activa o no existe.');
    if (b.hidden) throw Error('Esta batalla está en revisión.');
    if (!voter_id || !voted_user_id) throw Error('Faltan datos del voto.');
    if (b.creator_id === voter_id || b.opponent_id === voter_id) throw Error('No puedes votar en tu propia batalla.');
    if (voted_user_id !== b.creator_id && voted_user_id !== b.opponent_id) throw Error('Participante inválido.');

    const prior = await client.query('SELECT 1 FROM votes WHERE battle_id=$1 AND voter_id=$2', [battleId, voter_id]);
    if (prior.rowCount) throw Error('Ya votaste en esta batalla.');

    await client.query('INSERT INTO votes(battle_id, voter_id, voted_user_id) VALUES($1, $2, $3)', [battleId, voter_id, voted_user_id]);
    const vc = Number(b.votes_creator || 0) + (voted_user_id === b.creator_id ? 1 : 0);
    const vo = Number(b.votes_opponent || 0) + (voted_user_id === b.opponent_id ? 1 : 0);
    await client.query('UPDATE battles SET votes_creator=$1, votes_opponent=$2 WHERE id=$3', [vc, vo, battleId]);

    const total = vc + vo, diff = Math.abs(vc - vo);
    let completed = false, winner_id = null;

    if (total >= 10 && diff >= 3 && b.opponent_id) {
      winner_id = vc > vo ? b.creator_id : b.opponent_id;
      const loser = winner_id === b.creator_id ? b.opponent_id : b.creator_id;
      await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1', [winner_id]);
      await client.query('UPDATE users SET aura_points=GREATEST(0, aura_points-5) WHERE id=$1', [loser]);
      await client.query("UPDATE battles SET status='completed', winner_id=$1, closed_at=NOW() WHERE id=$2", [winner_id, battleId]);
      completed = true;
    }
    await client.query('COMMIT');
    res.json({ message: 'Voto registrado correctamente.', votes_creator: vc, votes_opponent: vo, total_votes: total, completed, winner_id });
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/battles/:id/report', writeLimiter, async (req, res) => {
  const battleId = req.params.id;
  const { reporter_id, reason } = req.body || {};
  if (!isValidId(reporter_id) || !reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'reporter_id y reason son obligatorios' });
  }
  const cleanReason = String(reason).trim().slice(0, 300);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const b = await client.query('SELECT id FROM battles WHERE id=$1 FOR UPDATE', [battleId]);
    if (!b.rows[0]) throw Error('Batalla no encontrada.');

    await client.query(
      'INSERT INTO reports(battle_id, reporter_id, reason) VALUES($1, $2, $3) ON CONFLICT (battle_id, reporter_id) DO NOTHING',
      [battleId, reporter_id, cleanReason]
    );
    const r = await client.query(
      `UPDATE battles SET report_count = report_count + 1,
         hidden = (report_count + 1 >= $2)
       WHERE id = $1 RETURNING report_count, hidden`,
      [battleId, REPORT_HIDE_THRESHOLD]
    );
    await client.query('COMMIT');
    res.json({ message: 'Reporte enviado. Gracias por ayudarnos a mantener AURA segura.', hidden: r.rows[0].hidden });
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

app.post('/api/webhooks/revenuecat', async (req, res) => {
  const providedSecret = req.header('Authorization');
  if (!REVENUECAT_WEBHOOK_SECRET || providedSecret !== `Bearer ${REVENUECAT_WEBHOOK_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  const event = req.body?.event;
  if (!event || event.type !== 'INITIAL_PURCHASE' && event.type !== 'NON_RENEWING_PURCHASE') {
    return res.json({ ignored: true });
  }
  const userId = event.app_user_id;
  const productId = event.product_id;
  const transactionId = String(event.transaction_id || event.id);
  const store = event.store === 'PLAY_STORE' ? 'play_store' : 'app_store';
  const product = PRODUCTS[productId];
  if (!isValidId(userId) || !product) return res.status(400).json({ error: 'Datos de evento inválidos' });

  try {
    const existing = await pool.query('SELECT 1 FROM purchases WHERE transaction_id=$1', [transactionId]);
    if (existing.rowCount) return res.json({ message: 'Ya procesada' });

    await pool.query('BEGIN');
    await pool.query(
      'INSERT INTO purchases(user_id, product_id, store, transaction_id, points_credited) VALUES($1,$2,$3,$4,$5)',
      [userId, productId, store, transactionId, product.points]
    );
    await pool.query('UPDATE users SET giftable_points = giftable_points + $1 WHERE id=$2', [product.points, userId]);
    await pool.query('COMMIT');
    res.json({ message: 'Puntos acreditados', points_credited: product.points });
  } catch (e) { await pool.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
});

app.post('/api/gifts', writeLimiter, async (req, res) => {
  const { sender_id, recipient_id, points } = req.body || {};
  const amount = Number(points);
  if (!isValidId(sender_id) || !isValidId(recipient_id) || !Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: 'Datos de regalo inválidos' });
  }
  if (sender_id === recipient_id) return res.status(400).json({ error: 'No podés regalarte puntos a vos mismo' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sender = await client.query('SELECT giftable_points, is_banned FROM users WHERE id=$1 FOR UPDATE', [sender_id]);
    if (!sender.rows[0]) throw Error('Remitente no encontrado.');
    if (sender.rows[0].is_banned) throw Error('Cuenta suspendida.');
    if (sender.rows[0].giftable_points < amount) throw Error('No tenés suficientes puntos para regalar.');

    const recipient = await client.query('SELECT 1 FROM users WHERE id=$1 AND deleted_at IS NULL', [recipient_id]);
    if (!recipient.rows[0]) throw Error('Destinatario no encontrado.');

    const today = await client.query(
      `SELECT COALESCE(SUM(points),0) AS total FROM gifts
       WHERE sender_id=$1 AND recipient_id=$2 AND created_at >= date_trunc('day', NOW())`,
      [sender_id, recipient_id]
    );
    if (Number(today.rows[0].total) + amount > DAILY_GIFT_LIMIT_PER_RECIPIENT) {
      throw Error(`Superaste el límite diario de ${DAILY_GIFT_LIMIT_PER_RECIPIENT} puntos para este destinatario.`);
    }

    await client.query('UPDATE users SET giftable_points = giftable_points - $1 WHERE id=$2', [amount, sender_id]);
    await client.query('UPDATE users SET aura_points = aura_points + $1 WHERE id=$2', [amount, recipient_id]);
    await client.query('INSERT INTO gifts(sender_id, recipient_id, points) VALUES($1,$2,$3)', [sender_id, recipient_id, amount]);
    await client.query('COMMIT');
    res.json({ message: 'Puntos regalados correctamente.' });
  } catch (e) { await client.query('ROLLBACK'); res.status(400).json({ error: e.message }); }
  finally { client.release(); }
});

app.get('/api/ads/reward', async (req, res) => {
  const { user_id, transaction_id, secret } = req.query;
  if (!ADS_SSV_SECRET || secret !== ADS_SSV_SECRET) return res.status(401).json({ error: 'No autorizado' });
  if (!isValidId(user_id) || !transaction_id) return res.status(400).json({ error: 'Datos inválidos' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query('SELECT 1 FROM ad_rewards WHERE transaction_id=$1', [transaction_id]);
    if (existing.rowCount) { await client.query('COMMIT'); return res.json({ message: 'Ya procesada' }); }

    const todayTotal = await client.query(
      `SELECT COALESCE(SUM(points_credited),0) AS total FROM ad_rewards
       WHERE user_id=$1 AND created_at >= date_trunc('day', NOW())`,
      [user_id]
    );
    if (Number(todayTotal.rows[0].total) >= DAILY_AD_POINTS_CAP) {
      await client.query('COMMIT');
      return res.json({ message: 'Límite diario de anuncios alcanzado', credited: 0 });
    }
    const toCredit = Math.min(POINTS_PER_AD, DAILY_AD_POINTS_CAP - Number(todayTotal.rows[0].total));

    await client.query(
      'INSERT INTO ad_rewards(user_id, transaction_id, points_credited) VALUES($1,$2,$3)',
      [user_id, transaction_id, toCredit]
    );
    await client.query('UPDATE users SET giftable_points = giftable_points + $1 WHERE id=$2', [toCredit, user_id]);
    await client.query('COMMIT');
    res.json({ message: 'Puntos acreditados', credited: toCredit });
  } catch (e) { await client.query('ROLLBACK'); res.status(500).json({ error: e.message }); }
  finally { client.release(); }
});

app.use((req, res) => res.status(404).json({ error: 'No encontrado' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor AURA ejecutándose en puerto ${PORT}`));
