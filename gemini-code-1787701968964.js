const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(express.json());

// Conexión a Supabase mediante la variable de entorno DATABASE_URL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

// Endpoint de prueba para verificar que el servidor está en vivo
app.get('/', (req, res) => {
  res.send('⚡ API de AURA funcionando correctamente en Render');
});

// Endpoint: Crear Batalla (Con control de máximo 5 simultáneas)
app.post('/api/battles', async (req, res) => {
  const { creator_id, category, title, media_url_creator } = req.body;

  try {
    const activeBattles = await pool.query(
      "SELECT COUNT(*) FROM battles WHERE creator_id = $1 AND status = 'active'",
      [creator_id]
    );

    if (parseInt(activeBattles.rows[0].count) >= 5) {
      return res.status(400).json({ error: 'Límite alcanzado: Máximo 5 batallas activas simultáneas.' });
    }

    const newBattle = await pool.query(
      `INSERT INTO battles (creator_id, category, title, media_url_creator) 
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [creator_id, category, title, media_url_creator]
    );

    res.status(201).json(newBattle.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Endpoint: Registrar Voto y Motor de Cierre (+20 / −5 Aura)
app.post('/api/battles/:id/vote', async (req, res) => {
  const battleId = req.params.id;
  const { voter_id, voted_user_id } = req.body;

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const battleRes = await client.query('SELECT * FROM battles WHERE id = $1 FOR UPDATE', [battleId]);
    const battle = battleRes.rows[0];

    if (!battle || battle.status !== 'active') {
      throw new Error('La batalla no está activa o no existe.');
    }

    if (battle.creator_id === voter_id || battle.opponent_id === voter_id) {
      throw new Error('No puedes votar en tu propia batalla.');
    }

    await client.query(
      'INSERT INTO votes (battle_id, voter_id, voted_user_id) VALUES ($1, $2, $3)',
      [battleId, voter_id, voted_user_id]
    );

    let votesCreator = battle.votes_creator + (voted_user_id === battle.creator_id ? 1 : 0);
    let votesOpponent = battle.votes_opponent + (voted_user_id === battle.opponent_id ? 1 : 0);

    await client.query(
      'UPDATE battles SET votes_creator = $1, votes_opponent = $2 WHERE id = $3',
      [votesCreator, votesOpponent, battleId]
    );

    // Regla de resolución de batallas: Mínimo 10 votos totales y diferencia mínima de 3
    const totalVotes = votesCreator + votesOpponent;
    const diff = Math.abs(votesCreator - votesOpponent);

    if (totalVotes >= 10 && diff >= 3) {
      const winnerId = votesCreator > votesOpponent ? battle.creator_id : battle.opponent_id;
      const loserId = winnerId === battle.creator_id ? battle.opponent_id : battle.creator_id;

      await client.query('UPDATE users SET aura_points = aura_points + 20 WHERE id = $1', [winnerId]);
      await client.query('UPDATE users SET aura_points = GREATEST(0, aura_points - 5) WHERE id = $1', [loserId]);

      await client.query(
        "UPDATE battles SET status = 'completed', winner_id = $1, closed_at = NOW() WHERE id = $2",
        [winnerId, battleId]
      );
    }

    await client.query('COMMIT');
    res.json({ message: 'Voto registrado correctamente.' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor AURA ejecutándose en puerto ${PORT}`));