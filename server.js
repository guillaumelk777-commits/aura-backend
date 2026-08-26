const express=require('express');
const cors=require('cors');
const {Pool}=require('pg');

const app=express();
app.use(cors());
app.use(express.json());

const pool=new Pool({connectionString:process.env.DATABASE_URL});

app.get('/',(req,res)=>res.json({app:'AURA',status:'ok',message:'⚡ API de AURA funcionando correctamente'}));
app.get('/api/health',async(req,res)=>{try{await pool.query('SELECT 1');res.json({status:'ok',database:'ok'})}catch(e){res.status(500).json({status:'error',database:e.message})}});

app.get('/api/battles',async(req,res)=>{
 try{
  const q=await pool.query(`SELECT * FROM battles WHERE status='active' ORDER BY created_at DESC`);
  res.json(q.rows);
 }catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/battles/:id',async(req,res)=>{
 try{const q=await pool.query('SELECT * FROM battles WHERE id=$1',[req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Batalla no encontrada'});res.json(q.rows[0])}
 catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/battles',async(req,res)=>{
 const{creator_id,category,title,media_url_creator}=req.body;
 if(!creator_id||!category||!title)return res.status(400).json({error:'creator_id, category y title son obligatorios'});
 try{
  const active=await pool.query("SELECT COUNT(*) FROM battles WHERE creator_id=$1 AND status='active'",[creator_id]);
  if(Number(active.rows[0].count)>=5)return res.status(400).json({error:'Límite alcanzado: Máximo 5 batallas activas simultáneas.'});
  const q=await pool.query(`INSERT INTO battles(creator_id,category,title,media_url_creator,status,votes_creator,votes_opponent) VALUES($1,$2,$3,$4,'active',0,0) RETURNING *`,[creator_id,category,title,media_url_creator||null]);
  res.status(201).json(q.rows[0]);
 }catch(e){res.status(500).json({error:e.message})}
});

app.post('/api/battles/:id/join',async(req,res)=>{
 const{opponent_id,media_url_opponent}=req.body;
 if(!opponent_id)return res.status(400).json({error:'opponent_id es obligatorio'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[req.params.id]);const b=q.rows[0];
  if(!b||b.status!=='active')throw Error('La batalla no está activa o no existe.');
  if(b.creator_id===opponent_id)throw Error('No puedes unirte a tu propia batalla.');
  if(b.opponent_id)throw Error('La batalla ya tiene oponente.');
  const r=await client.query('UPDATE battles SET opponent_id=$1,media_url_opponent=$2 WHERE id=$3 RETURNING *',[opponent_id,media_url_opponent||null,req.params.id]);
  await client.query('COMMIT');res.json(r.rows[0]);
 }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

app.post('/api/battles/:id/vote',async(req,res)=>{
 const battleId=req.params.id;const{voter_id,voted_user_id}=req.body;const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const q=await client.query('SELECT * FROM battles WHERE id=$1 FOR UPDATE',[battleId]);const b=q.rows[0];
  if(!b||b.status!=='active')throw Error('La batalla no está activa o no existe.');
  if(!voter_id||!voted_user_id)throw Error('Faltan datos del voto.');
  if(b.creator_id===voter_id||b.opponent_id===voter_id)throw Error('No puedes votar en tu propia batalla.');
  if(voted_user_id!==b.creator_id&&voted_user_id!==b.opponent_id)throw Error('Participante inválido.');
  const prior=await client.query('SELECT 1 FROM votes WHERE battle_id=$1 AND voter_id=$2',[battleId,voter_id]);
  if(prior.rowCount)throw Error('Ya votaste en esta batalla.');
  await client.query('INSERT INTO votes(battle_id,voter_id,voted_user_id) VALUES($1,$2,$3)',[battleId,voter_id,voted_user_id]);
  const vc=Number(b.votes_creator||0)+(voted_user_id===b.creator_id?1:0);
  const vo=Number(b.votes_opponent||0)+(voted_user_id===b.opponent_id?1:0);
  await client.query('UPDATE battles SET votes_creator=$1,votes_opponent=$2 WHERE id=$3',[vc,vo,battleId]);
  const total=vc+vo,diff=Math.abs(vc-vo);let completed=false,winner_id=null;
  if(total>=10&&diff>=3&&b.opponent_id){
   winner_id=vc>vo?b.creator_id:b.opponent_id;const loser=winner_id===b.creator_id?b.opponent_id:b.creator_id;
   await client.query('UPDATE users SET aura_points=aura_points+20 WHERE id=$1',[winner_id]);
   await client.query('UPDATE users SET aura_points=GREATEST(0,aura_points-5) WHERE id=$1',[loser]);
   await client.query("UPDATE battles SET status='completed',winner_id=$1,closed_at=NOW() WHERE id=$2",[winner_id,battleId]);completed=true;
  }
  await client.query('COMMIT');res.json({message:'Voto registrado correctamente.',votes_creator:vc,votes_opponent:vo,total_votes:total,completed,winner_id});
 }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message})}finally{client.release()}
});

app.get('/api/users/ranking',async(req,res)=>{
 try{const q=await pool.query('SELECT * FROM users ORDER BY aura_points DESC NULLS LAST LIMIT 50');res.json(q.rows)}catch(e){res.status(500).json({error:e.message})}
});

app.get('/api/users/:id',async(req,res)=>{
 try{const q=await pool.query('SELECT * FROM users WHERE id=$1',[req.params.id]);if(!q.rows[0])return res.status(404).json({error:'Usuario no encontrado'});res.json(q.rows[0])}catch(e){res.status(500).json({error:e.message})}
});

const PORT=process.env.PORT||3000;
app.listen(PORT,()=>console.log(`Servidor AURA ejecutándose en puerto ${PORT}`));
